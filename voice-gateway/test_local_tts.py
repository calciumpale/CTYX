import asyncio
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import httpx
import numpy as np


SPEC = importlib.util.find_spec("local_tts")
if SPEC:
    import local_tts


class LocalTtsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.assertIsNotNone(SPEC, "A native local TTS adapter must exist")

    async def test_catalog_is_actual_runtime_count_with_correct_v11_languages(self):
        voices = local_tts.voice_catalog(103)
        self.assertEqual(len(voices), 103)
        self.assertEqual(voices[48]["id"], "speaker-48")
        self.assertIn("zf_084", voices[48]["name"])
        self.assertEqual(voices[48]["lang"], "zh-CN")
        self.assertEqual(voices[58]["lang"], "zh-CN")
        self.assertEqual(voices[0]["lang"], "en-US")
        self.assertEqual(len(local_tts.voice_catalog(4)), 4)

    async def test_model_file_override_keeps_int8_available_and_prefers_fp32(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.int8.onnx").touch()
            (root / "model.onnx").touch()
            with patch.dict(os.environ, {"LOCAL_TTS_MODEL_FILE": ""}):
                self.assertEqual(local_tts.resolve_model_file(root), root / "model.onnx")
            with patch.dict(os.environ, {"LOCAL_TTS_MODEL_FILE": "model.int8.onnx"}):
                self.assertEqual(local_tts.resolve_model_file(root), root / "model.int8.onnx")

    async def test_pcm_is_little_endian_clipped_and_contains_no_wav_header(self):
        pcm = local_tts.pcm16(np.array([-2, -1, 0, 1, 2], dtype=np.float32))
        self.assertEqual(np.frombuffer(pcm, dtype="<i2").tolist(), [-32768, -32768, 0, 32767, 32767])
        self.assertFalse(pcm.startswith(b"RIFF"))

    async def test_nonfinite_native_audio_is_rejected_instead_of_silent_pcm(self):
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            local_tts.pcm16(np.array([0.1, np.nan, np.inf], dtype=np.float32))

    async def test_short_comma_clauses_merge_without_inventing_words(self):
        self.assertEqual(local_tts.merge_short_clauses("您好，关于免租期，我想确认时间。"), "您好 关于免租期，我想确认时间。")
        self.assertEqual(local_tts.merge_short_clauses("好的。"), "好的。")
        self.assertEqual(local_tts.merge_short_clauses("关于免租期，"), "关于免租期，")

    async def test_first_sentence_is_yielded_before_remaining_generation_finishes(self):
        proceed = threading.Event()

        class Engine:
            sample_rate = 24000
            num_speakers = 103

            def generate(self, text, sid=0, speed=1, callback=None):
                callback(np.ones(2400, dtype=np.float32) * 0.2, 0.5)
                if not proceed.wait(2):
                    raise RuntimeError("stream waited for the entire utterance")
                callback(np.ones(2400, dtype=np.float32) * -0.2, 1)

        stream = local_tts.PcmSynthesizer(Engine()).stream("第一句。第二句。", 48, 1)
        try:
            first = await asyncio.wait_for(anext(stream), 1)
            self.assertEqual(len(first), 4800)
            proceed.set()
            chunks = [part async for part in stream]
            self.assertEqual(sum(map(len, chunks)), 4800)
        finally:
            proceed.set()
            await stream.aclose()

    async def test_cancellation_stops_callback_and_does_not_fill_unbounded_queue(self):
        exited = threading.Event()

        class Engine:
            sample_rate = 24000
            num_speakers = 103

            def generate(self, text, sid=0, speed=1, callback=None):
                try:
                    for _ in range(1000):
                        if not callback(np.ones(2400, dtype=np.float32), 0.5):
                            break
                finally:
                    exited.set()

        stream = local_tts.PcmSynthesizer(Engine()).stream("长句", 48, 1)
        await asyncio.wait_for(anext(stream), 1)
        await stream.aclose()
        self.assertTrue(await asyncio.to_thread(exited.wait, 1))

    async def test_http_pcm_and_catalog_and_invalid_requests(self):
        class Engine:
            sample_rate = 24000
            num_speakers = 103

            def generate(self, text, sid=0, speed=1, callback=None):
                callback(np.array([-0.5, 0.5], dtype=np.float32), 1)

        app = local_tts.create_app(lambda: Engine())
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local") as client:
                response = await client.get("/v1/audio/voices")
                self.assertEqual(len(response.json()["voices"]), 103)
                request = {"model": "kokoro", "input": "你好", "voice": "speaker-48", "response_format": "pcm", "speed": 1}
                response = await client.post("/v1/audio/speech", json=request)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "audio/pcm")
                self.assertEqual(response.headers["x-audio-sample-rate"], "24000")
                self.assertEqual(np.frombuffer(response.content, dtype="<i2").tolist(), [-16384, 16384])
                for invalid in ({"voice": "speaker-103"}, {"response_format": "mp3"}, {"speed": 0}, {"input": ""}, {"model": "other"}):
                    with self.subTest(invalid=invalid):
                        failed = await client.post("/v1/audio/speech", json={**request, **invalid})
                        self.assertIn(failed.status_code, (400, 422))

    async def test_nonfinite_first_sentence_returns_visible_http_failure(self):
        class Engine:
            sample_rate = 24000
            num_speakers = 103

            def generate(self, text, sid=0, speed=1, callback=None):
                callback(np.full(24000, np.nan, dtype=np.float32), 1)

        app = local_tts.create_app(lambda: Engine())
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://local") as client:
                response = await client.post("/v1/audio/speech", json={"input":"好的。", "voice":"speaker-48"})
                self.assertEqual(response.status_code, 503)
                self.assertIn("有效语音", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
