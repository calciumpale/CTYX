"""Loopback-only Kokoro v1.1-zh ONNX adapter, without PyTorch or Misaki.

Run: .venv/bin/python local_tts.py --port 8002
Weights: models/kokoro-int8-multi-lang-v1_1 (LOCAL_TTS_MODEL_DIR overrides).
LOCAL_TTS_MODEL_FILE selects a specific model; otherwise model.onnx (fp32)
is preferred over model.int8.onnx. Both can coexist for numerical comparison.
Audio becomes available at sentence callbacks; this is not token streaming.
Official speaker map:
https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html
"""
from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import os
import re
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


# Ordered exactly as the official v1.1-zh map; v1.0 IDs differ.
SPEAKERS = (
    "af_maple af_sol bf_vale "
    "zf_001 zf_002 zf_003 zf_004 zf_005 zf_006 zf_007 zf_008 zf_017 "
    "zf_018 zf_019 zf_021 zf_022 zf_023 zf_024 zf_026 zf_027 zf_028 "
    "zf_032 zf_036 zf_038 zf_039 zf_040 zf_042 zf_043 zf_044 zf_046 "
    "zf_047 zf_048 zf_049 zf_051 zf_059 zf_060 zf_067 zf_070 zf_071 "
    "zf_072 zf_073 zf_074 zf_075 zf_076 zf_077 zf_078 zf_079 zf_083 "
    "zf_084 zf_085 zf_086 zf_087 zf_088 zf_090 zf_092 zf_093 zf_094 zf_099 "
    "zm_009 zm_010 zm_011 zm_012 zm_013 zm_014 zm_015 zm_016 zm_020 "
    "zm_025 zm_029 zm_030 zm_031 zm_033 zm_034 zm_035 zm_037 zm_041 "
    "zm_045 zm_050 zm_052 zm_053 zm_054 zm_055 zm_056 zm_057 zm_058 "
    "zm_061 zm_062 zm_063 zm_064 zm_065 zm_066 zm_068 zm_069 zm_080 "
    "zm_081 zm_082 zm_089 zm_091 zm_095 zm_096 zm_097 zm_098 zm_100"
).split()


def voice_catalog(num_speakers):
    if not 1 <= num_speakers <= len(SPEAKERS):
        raise ValueError("This adapter needs the official Kokoro v1.1-zh speaker map")
    result = []
    for sid, name in enumerate(SPEAKERS[:num_speakers]):
        chinese = name.startswith("z")
        label = "中文女声" if name.startswith("zf") else "中文男声" if chinese else "英文女声"
        result.append({"id": f"speaker-{sid}", "name": f"{label} {sid} · {name}",
                       "lang": "zh-CN" if chinese else "en-GB" if name.startswith("bf") else "en-US",
                       "description": "Kokoro v1.1-zh 本机 ONNX；听感待人工试听"})
    return result


def pcm16(samples):
    values = np.asarray(samples, dtype=np.float32)
    if not np.all(np.isfinite(values)):
        raise ValueError("Local ONNX model returned nonfinite audio")
    return np.clip(np.rint(values * 32768), -32768, 32767).astype("<i2").tobytes()


def merge_short_clauses(text):
    """Keep words intact; avoid ONNX NaNs from tiny comma-separated greetings."""
    parts = re.split(r"([，,。！？!?；;\n])", text)
    for index in range(1, len(parts), 2):
        if parts[index] in {"，", ","} and "".join(parts[index + 1:]).strip():
            letters = re.findall(r"[\w]", parts[index - 1])
            if 0 < len(letters) < 5:
                parts[index] = " "
    return "".join(parts)


def resolve_model_file(root):
    configured = os.environ.get("LOCAL_TTS_MODEL_FILE", "").strip()
    if configured:
        path = Path(configured)
        return path if path.is_absolute() else root / path
    return next((root / name for name in ("model.onnx", "model.int8.onnx") if (root / name).is_file()), root / "model.onnx")


def load_engine():
    import sherpa_onnx

    root = Path(os.environ.get("LOCAL_TTS_MODEL_DIR", str(Path(__file__).parent / "models/kokoro-int8-multi-lang-v1_1")))
    model = resolve_model_file(root)
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=str(model), voices=str(root / "voices.bin"), tokens=str(root / "tokens.txt"),
                data_dir=str(root / "espeak-ng-data"),
                lexicon=",".join(str(root / name) for name in ("lexicon-us-en.txt", "lexicon-zh.txt")),
            ),
            num_threads=int(os.environ.get("LOCAL_TTS_NUM_THREADS", "2")), provider="cpu",
        ),
        rule_fsts=",".join(str(root / name) for name in ("phone-zh.fst", "date-zh.fst", "number-zh.fst")),
        max_num_sentences=1,
    )
    if not config.validate():
        raise ValueError("Local TTS model configuration is invalid; download the documented Kokoro v1.1-zh archive")
    engine = sherpa_onnx.OfflineTts(config)
    if engine.sample_rate != 24000 or engine.num_speakers != 103:
        raise ValueError("Expected the 24 kHz, 103-speaker Kokoro v1.1-zh model")
    return engine


class PcmSynthesizer:
    def __init__(self, engine):
        self.engine = engine
        self.lock = threading.Lock()

    async def stream(self, text, sid, speed):
        """Native inference stays off the event loop; a bounded queue backpressures it.

        Cancelling a response sets a flag immediately. The native engine observes
        that flag at the next sentence callback, not during an ONNX kernel.
        """
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue(maxsize=8)
        cancelled = threading.Event()
        end = object()

        def put(value):
            if cancelled.is_set():
                return False
            future = asyncio.run_coroutine_threadsafe(queue.put(value), loop)
            try:
                while not cancelled.is_set():
                    try:
                        future.result(timeout=0.05)
                        return True
                    except concurrent.futures.TimeoutError:
                        continue
                return False
            finally:
                if not future.done():
                    future.cancel()

        def generate():
            acquired = False
            callbacks = 0
            try:
                while not cancelled.is_set():
                    if self.lock.acquire(timeout=0.05):
                        acquired = True
                        break
                if not acquired or cancelled.is_set():
                    return

                def callback(samples, _progress):
                    nonlocal callbacks
                    callbacks += 1
                    data = pcm16(samples)
                    for offset in range(0, len(data), 4800):
                        if not put(data[offset:offset + 4800]):
                            return 0
                    return 0 if cancelled.is_set() else 1

                audio = self.engine.generate(merge_short_clauses(text), sid=sid, speed=speed, callback=callback)
                # Engines normally callback once per sentence. Do not duplicate
                # their final combined samples; use them only if no callback ran.
                if not callbacks and not cancelled.is_set():
                    callback(audio.samples, 1)
            except Exception:
                if not cancelled.is_set():
                    put(RuntimeError("Local ONNX speech generation failed"))
            finally:
                if acquired:
                    self.lock.release()
                if not cancelled.is_set():
                    put(end)

        worker = threading.Thread(target=generate, daemon=True, name="local-kokoro-tts")
        worker.start()
        try:
            while True:
                item = await queue.get()
                if item is end:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            cancelled.set()


class SpeechRequest(BaseModel):
    model: str = "kokoro"
    input: str = Field(min_length=1, max_length=4000)
    voice: str = "speaker-48"
    response_format: str = "pcm"
    speed: float = Field(default=1.0, ge=0.5, le=2.0, allow_inf_nan=False)


def create_app(engine_factory=load_engine):
    @asynccontextmanager
    async def lifespan(app):
        engine = await asyncio.to_thread(engine_factory)
        app.state.synthesizer = PcmSynthesizer(engine)
        app.state.voices = voice_catalog(engine.num_speakers)
        yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/healthz")
    async def health():
        return {"loaded": True, "model": "kokoro-v1.1-zh", "sampleRate": 24000, "numSpeakers": len(app.state.voices), "streaming": "sentence-callback"}

    @app.get("/v1/audio/voices")
    async def voices():
        return {"voices": app.state.voices}

    @app.post("/v1/audio/speech")
    async def speech(request: SpeechRequest):
        match = re.fullmatch(r"speaker-(\d+)", request.voice)
        if request.model != "kokoro" or request.response_format != "pcm" or not request.input.strip():
            raise HTTPException(400, "Use model=kokoro, nonempty input, response_format=pcm")
        if not match or int(match[1]) >= len(app.state.voices):
            raise HTTPException(400, "Unknown voice; list /v1/audio/voices")
        stream = app.state.synthesizer.stream(request.input.strip(), int(match[1]), request.speed)
        try:
            first = await anext(stream)
        except Exception:
            await stream.aclose()
            raise HTTPException(503, "本地模型未生成有效语音，请使用完整句子或切换音色") from None

        async def body():
            try:
                yield first
                async for chunk in stream:
                    yield chunk
            finally:
                await stream.aclose()

        return StreamingResponse(
            body(),
            media_type="audio/pcm",
            headers={"X-Audio-Sample-Rate": "24000", "X-Audio-Channels": "1", "Cache-Control": "no-store"},
        )

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8002)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, workers=1)
