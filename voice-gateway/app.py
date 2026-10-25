"""Self-hosted duplex PCM gateway. Dialogue and persistence stay in the app."""
from __future__ import annotations

import asyncio
import json
import ipaddress
import logging
import os
import threading
import time
import uuid
import base64
import zlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import numpy as np
import sherpa_onnx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from gateway_core import AudioBudget, OutputChannel, ProtocolError, ReplayCache, parse_command, parse_json, verify_token
from recording_jobs import RecordingJobs, router as recording_router, validate_options, correct_result
from offline_asr import OfflineASR

logger = logging.getLogger("training_voice_gateway")


class Settings:
    def __init__(self):
        self.secret = os.environ.get("VOICE_GATEWAY_SECRET", "")
        if len(self.secret.encode()) < 32:
            raise ValueError("VOICE_GATEWAY_SECRET must contain at least 32 bytes")
        self.origins = {value.strip() for value in os.environ.get("ALLOWED_ORIGINS", "").split(",") if value.strip()}
        if not self.origins:
            raise ValueError("ALLOWED_ORIGINS must explicitly list the workbench origins")
        for origin in self.origins:
            parts = urlsplit(origin)
            if parts.scheme not in {"https", "http"} or not parts.netloc or parts.path or parts.query or parts.fragment or parts.username or origin == "null":
                raise ValueError("ALLOWED_ORIGINS entries must be exact origins without paths or credentials")
            if parts.scheme == "http":
                try:
                    loopback = ipaddress.ip_address(parts.hostname).is_loopback
                except ValueError:
                    loopback = parts.hostname == "localhost"
                if not loopback:
                    raise ValueError("Plain HTTP origins are permitted only on loopback for local development")
        self.model_dir = Path(os.environ.get("ASR_MODEL_DIR", "/models/asr"))
        self.asr_threads = int(os.environ.get("ASR_NUM_THREADS", "2"))
        self.asr_workers = int(os.environ.get("ASR_WORKERS", "2"))
        self.endpoint_silence = float(os.environ.get("ASR_ENDPOINT_SILENCE", "0.7"))
        self.max_sessions = int(os.environ.get("MAX_SESSIONS", "4"))
        if not 1 <= self.asr_threads <= 16 or not 1 <= self.asr_workers <= 8 or not 1 <= self.max_sessions <= 32:
            raise ValueError("ASR threads/workers or MAX_SESSIONS are outside supported bounds")
        if not 0.3 <= self.endpoint_silence <= 2.0:
            raise ValueError("ASR_ENDPOINT_SILENCE must be between 0.3 and 2.0 seconds")
        self.tts_base = os.environ.get("TTS_BASE_URL", "").rstrip("/")
        base = urlsplit(self.tts_base)
        if base.scheme not in {"https", "http"} or not base.netloc or base.username or base.password or base.query or base.fragment:
            raise ValueError("TTS_BASE_URL must be a configured HTTP(S) base URL without credentials or query")
        self.tts_model = os.environ.get("TTS_MODEL", "").strip()
        if not self.tts_model:
            raise ValueError("TTS_MODEL must name the deployed model")
        self.tts_key = os.environ.get("TTS_API_KEY", "")
        self.tts_style = os.environ.get("TTS_STYLE", "openai")
        if self.tts_style not in {"openai", "qwen"}:
            raise ValueError("TTS_STYLE must be openai or qwen")
        self.voices = json.loads(os.environ.get("TTS_VOICES", "[]"))
        if not isinstance(self.voices, list) or not 1 <= len(self.voices) <= 128:
            raise ValueError("TTS_VOICES must list 1 to 128 voices actually installed in the provider")
        ids = set()
        for voice in self.voices:
            if not isinstance(voice, dict) or any(not isinstance(voice.get(key), str) or not 0 < len(voice[key]) <= 200 for key in ("id", "name", "lang")) or voice["id"] in ids:
                raise ValueError("Each TTS_VOICES entry needs unique id, name and lang")
            if "description" in voice and (not isinstance(voice["description"], str) or len(voice["description"]) > 500):
                raise ValueError("Voice descriptions must be at most 500 characters")
            ids.add(voice["id"])
        # Return only catalogue fields, never arbitrary provider configuration.
        self.voices = [{key: voice[key] for key in ("id", "name", "lang", "description") if key in voice} for voice in self.voices]
        self.default_voice = os.environ.get("TTS_DEFAULT_VOICE") or self.voices[0]["id"]
        if self.default_voice not in ids:
            raise ValueError("TTS_DEFAULT_VOICE must occur in TTS_VOICES")
        self.voice_ids = ids


class StreamingASR:
    def __init__(self, settings):
        paths = {key: settings.model_dir / os.environ.get("ASR_" + key.upper() + "_FILE", default) for key, default in {"tokens": "tokens.txt", "encoder": "encoder.int8.onnx", "decoder": "decoder.onnx", "joiner": "joiner.int8.onnx"}.items()}
        if any(not value.is_file() for value in paths.values()):
            raise ValueError("ASR model files are missing; download and mount the documented streaming transducer model")
        self.lock = threading.Lock()
        self.tokens = {line.rsplit(' ', 1)[0] for line in paths['tokens'].read_text().splitlines() if ' ' in line}
        self.recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            **{key: str(value) for key, value in paths.items()},
            sample_rate=16000, feature_dim=80, num_threads=settings.asr_threads,
            provider="cpu", decoding_method="modified_beam_search", max_active_paths=4,
            modeling_unit="cjkchar", hotwords_score=1.5, enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=settings.endpoint_silence,
            rule3_min_utterance_length=20.0,
        )

    def create_stream(self, hotwords=None):
        with self.lock:
            phrases = []
            for word in hotwords or []:
                term = word['term']
                if word['enabled'] and all('\u3400' <= char <= '\u9fff' and char in self.tokens for char in term):
                    phrases.append(' '.join(term))
            return self.recognizer.create_stream('\n'.join(phrases)) if phrases else self.recognizer.create_stream()

    def accept(self, stream, pcm):
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        # A shared recognizer is protected across per-socket worker calls. There
        # is at most one pending decode per admitted connection, no audio queue.
        with self.lock:
            stream.accept_waveform(16000, samples)
            while self.recognizer.is_ready(stream):
                self.recognizer.decode_stream(stream)
            text = self.recognizer.get_result(stream).strip()
            endpoint = self.recognizer.is_endpoint(stream)
            if endpoint:
                self.recognizer.reset(stream)
            return text, endpoint


@asynccontextmanager
async def lifespan(app):
    settings = Settings()
    app.state.settings = settings
    app.state.asr = StreamingASR(settings)
    app.state.executor = ThreadPoolExecutor(max_workers=settings.asr_workers, thread_name_prefix="voice-asr")
    app.state.decode_slots = asyncio.Semaphore(settings.asr_workers)
    app.state.tickets = ReplayCache()
    app.state.active = 0
    app.state.tts_status = {"probe": "not_performed", "lastSynthesis": None}
    app.state.recordings = RecordingJobs(OfflineASR())
    app.state.recordings.start()
    async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=20, write=10, pool=10), follow_redirects=False, trust_env=False) as client:
        app.state.http = client
        try:
            yield
        finally:
            await app.state.recordings.close()
    app.state.executor.shutdown(wait=True, cancel_futures=True)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(recording_router)


def live_speech_profile(claims):
    value = claims.get('speechProfile')
    if value is None:
        return validate_options({})
    try:
        if not isinstance(value, str) or len(value) > 10_000:
            raise ValueError()
        decoder = zlib.decompressobj()
        unpacked = decoder.decompress(base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)), 64_001)
        if len(unpacked) > 64_000 or not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
            raise ValueError()
        return validate_options({'hotwords': json.loads(unpacked)})
    except (ValueError, TypeError, zlib.error) as error:
        raise ProtocolError('实时语音热词设置无效，请在设置中检查') from error


@app.get("/healthz")
async def healthz():
    return {"asr": {"loaded": True, "sampleRate": 16000}, "tts": {"configured": True, "sampleRate": 24000, **app.state.tts_status}, "activeSessions": app.state.active}


def tts_payload(settings, command):
    payload = {"model": settings.tts_model, "input": command["text"], "voice": command["voice"], "response_format": "pcm"}
    if settings.tts_style == "qwen":
        payload.update(stream=True, stream_format="audio")
    else:
        payload["speed"] = command["rate"]
    return payload


async def synthesize(command):
    settings = app.state.settings
    headers = {"Authorization": "Bearer " + settings.tts_key} if settings.tts_key else {}
    total = 0
    try:
        async with app.state.http.stream("POST", settings.tts_base + "/audio/speech", headers=headers, json=tts_payload(settings, command)) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
            if content_type not in {"application/octet-stream", "audio/pcm", "audio/raw", "audio/l16", ""}:
                raise ProtocolError("TTS provider must stream raw 24kHz PCM16LE, not WAV/MP3/JSON/SSE")
            first = True
            async for chunk in response.aiter_bytes(chunk_size=4800):
                if first and chunk.startswith((b"RIFF", b"ID3", b"OggS", b"fLaC")):
                    raise ProtocolError("TTS returned encoded audio instead of raw PCM")
                first = False
                total += len(chunk)
                if total > 24_000 * 2 * 180:
                    raise ProtocolError("TTS output exceeds three minutes")
                yield chunk
        if total:
            app.state.tts_status = {"probe": "not_performed", "lastSynthesis": "succeeded", "lastSynthesisAt": int(time.time())}
    except asyncio.CancelledError:
        raise
    except Exception as error:
        app.state.tts_status = {"probe": "not_performed", "lastSynthesis": "failed", "lastSynthesisAt": int(time.time())}
        # Log error class only. Provider bodies can contain text or secrets.
        logger.warning("TTS synthesis failed (%s)", type(error).__name__)
        raise


@app.websocket("/ws")
async def voice_socket(websocket: WebSocket):
    settings = app.state.settings
    if websocket.headers.get("origin") not in settings.origins:
        await websocket.close(code=1008, reason="Origin not allowed")
        return
    await websocket.accept()
    output = None
    admitted = False
    send_lock = asyncio.Lock()

    async def send(value):
        async with send_lock:
            operation = websocket.send_bytes(value) if isinstance(value, bytes) else websocket.send_json(value)
            await asyncio.wait_for(operation, timeout=5)

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        start = parse_json(raw)
        if start.get("type") != "session.start":
            raise ProtocolError("请先发送session.start认证消息")
        claims = verify_token(start.get("token"), settings.secret, app.state.tickets)
        speech_profile = live_speech_profile(claims)
        if app.state.active >= settings.max_sessions:
            raise ProtocolError("语音服务连接已满，请稍后重试")
        app.state.active += 1
        admitted = True
        stream = app.state.asr.create_stream(speech_profile['hotwords']) if speech_profile['hotwords'] else app.state.asr.create_stream()
        output = OutputChannel(send, synthesize)
        await send({"type": "session.ready", "sampleRate": 24000, "voices": settings.voices, "defaultVoice": settings.default_voice})
        budget = AudioBudget()
        loop = asyncio.get_running_loop()
        speech_started = False
        previous_partial = ""
        control_count, control_window = 0, time.monotonic()

        async def receive_loop():
            nonlocal speech_started, previous_partial, control_count, control_window
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    pcm = message["bytes"]
                    budget.consume(pcm)
                    async with app.state.decode_slots:
                        inference = loop.run_in_executor(app.state.executor, app.state.asr.accept, stream, pcm)
                        try:
                            text, endpoint = await asyncio.shield(inference)
                        except asyncio.CancelledError:
                            # Python cannot cancel native inference. Keep its
                            # slot until it really finishes, including shutdown.
                            with suppress(Exception):
                                await inference
                            raise
                    if text and not speech_started:
                        speech_started = True
                        # Cancels HTTP generation and drains old PCM before the
                        # browser sees the speech-start interruption event.
                        await output.cancel()
                        await send({"type": "input.speech.started"})
                    if text and text != previous_partial:
                        previous_partial = text
                        await send({"type": "input.partial", "text": text})
                    if endpoint:
                        if text:
                            corrected = correct_result({'segments': [{'text': text}]}, speech_profile)
                            await send({"type": "input.final", "id": str(uuid.uuid4()), "text": corrected['text'], "rawText": text, "corrections": corrected['corrections']})
                        speech_started, previous_partial = False, ""
                elif message.get("text") is not None:
                    now = time.monotonic()
                    if now - control_window >= 1:
                        control_count, control_window = 0, now
                    control_count += 1
                    if control_count > 20:
                        raise ProtocolError("语音控制消息过于频繁")
                    command = parse_command(message["text"], settings.voice_ids)
                    if command["type"] == "output.cancel":
                        await output.cancel()
                    elif speech_started:
                        # A previous turn's HTTP reply can arrive after the
                        # user has already begun the next utterance.
                        await send({"type": "output.cancelled", "id": command["id"]})
                    else:
                        await output.speak(command)
                else:
                    raise ProtocolError("不支持的WebSocket消息")

        # Token expiry is checked once at handshake. Session time is separately
        # limited to 30 minutes; reconnecting always requires a fresh ticket.
        await asyncio.wait_for(receive_loop(), timeout=30 * 60)
    except asyncio.TimeoutError:
        with suppress(Exception):
            await send({"type": "session.error", "code": "timeout", "message": "语音连接超时或已满30分钟，请重新连接"})
    except ProtocolError as error:
        with suppress(Exception):
            await send({"type": "session.error", "code": "invalid_request", "message": str(error)})
    except WebSocketDisconnect:
        pass
    except Exception as error:
        logger.warning("Voice session failed (%s)", type(error).__name__)
        with suppress(Exception):
            await send({"type": "session.error", "code": "gateway_failed", "message": "自部署语音服务中断，请重新连接或切换文字带练"})
    finally:
        if output:
            with suppress(Exception):
                await output.cancel()
        if admitted:
            app.state.active -= 1
        with suppress(Exception):
            await websocket.close()
