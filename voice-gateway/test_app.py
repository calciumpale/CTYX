"""ASGI/socket integration. Only model inference and TTS provider are doubled."""
import asyncio
import json
import os
import time
import unittest
import uuid
import zlib
import base64
import tempfile
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app as gateway
from test_gateway import SECRET, token


TEST_JOB_DIR = tempfile.TemporaryDirectory(prefix='voice-gateway-test-')
ENV = {
    "RECORDING_JOB_DIR": TEST_JOB_DIR.name,
    "VOICE_GATEWAY_SECRET": SECRET,
    "ALLOWED_ORIGINS": "https://workbench.example",
    "TTS_BASE_URL": "http://tts:8880/v1",
    "TTS_MODEL": "kokoro",
    "TTS_VOICES": '[{"id":"zh_1","name":"中文音色","lang":"zh-CN"}]',
}


class ModelBoundary:
    def __init__(self, settings):
        pass

    def create_stream(self):
        return {"chunks": 0}

    def accept(self, stream, pcm):
        stream["chunks"] += 1
        return "我想先了解交付时间", stream["chunks"] % 2 == 0


class SettingsTests(unittest.TestCase):
    def test_one_hundred_installed_chinese_voices_are_not_silently_truncated(self):
        catalogue = [{"id": f"speaker-{index}", "name": f"中文 {index}", "lang": "zh-CN"} for index in range(3, 103)]
        with patch.dict(os.environ, {**ENV, "TTS_VOICES": json.dumps(catalogue), "TTS_DEFAULT_VOICE": "speaker-48"}, clear=True):
            settings = gateway.Settings()
        self.assertEqual(len(settings.voices), 100)
        self.assertEqual(settings.default_voice, "speaker-48")

    def test_qwen_stream_payload_omits_unsupported_speed_and_preserves_exact_text(self):
        with patch.dict(os.environ, {**ENV, "TTS_STYLE": "qwen"}, clear=True):
            settings = gateway.Settings()
        payload = gateway.tts_payload(settings, {"text": "请问您的预算？", "voice": "zh_1", "rate": 1.2})
        self.assertEqual(payload["input"], "请问您的预算？")
        self.assertEqual(payload["stream_format"], "audio")
        self.assertTrue(payload["stream"])
        self.assertNotIn("async_chunk", payload)
        self.assertNotIn("speed", payload)
        self.assertEqual(payload["response_format"], "pcm")

    def test_settings_reject_unbounded_origins_and_unconfigured_voices(self):
        for change in ({"ALLOWED_ORIGINS": ""}, {"ALLOWED_ORIGINS": "*"}, {"ALLOWED_ORIGINS": "http://public.example"}, {"ALLOWED_ORIGINS": "https://example.com/path"}, {"TTS_VOICES": "[]"}, {"TTS_DEFAULT_VOICE": "missing"}):
            with self.subTest(change=change), patch.dict(os.environ, {**ENV, **change}, clear=True), self.assertRaises(ValueError):
                gateway.Settings()

    def test_http_is_allowed_only_for_local_loopback_development(self):
        with patch.dict(os.environ, {**ENV, "ALLOWED_ORIGINS": "http://127.0.0.1:5173,http://localhost:5173"}, clear=True):
            self.assertIn("http://127.0.0.1:5173", gateway.Settings().origins)


class SocketTests(unittest.TestCase):
    def test_signed_hotwords_reach_decoder_and_final_is_corrected_without_a_manual_send(self):
        words = [{"term": "实施周期", "aliases": ["交付时间"], "enabled": True}]
        packed = base64.urlsafe_b64encode(zlib.compress(json.dumps(words).encode())).decode().rstrip('=')
        class HotwordBoundary(ModelBoundary):
            def create_stream(self, hotwords=None):
                self.words = hotwords
                return {"chunks": 0}
        with patch.dict(os.environ, ENV, clear=True), patch.object(gateway, "StreamingASR", HotwordBoundary), self.client() as client:
            ticket = token({"exp": int(time.time()) + 300, "jti": str(uuid.uuid4()), "speechProfile": packed})
            with client.websocket_connect('/ws', headers={"origin": ENV["ALLOWED_ORIGINS"]}) as socket:
                socket.send_json({"type": "session.start", "token": ticket})
                self.assertEqual(socket.receive_json()['type'], 'session.ready')
                self.assertEqual(gateway.app.state.asr.words, words)
                socket.send_bytes(b'\x00\x00' * 320)
                self.assertEqual(socket.receive_json()['type'], 'input.speech.started')
                socket.receive_json()
                socket.send_bytes(b'\x00\x00' * 320)
                final = socket.receive_json()
                self.assertEqual(final['text'], '我想先了解实施周期')
                self.assertEqual(final['rawText'], '我想先了解交付时间')
                self.assertEqual(final['corrections'], [{'from': '交付时间', 'to': '实施周期', 'count': 1}])

    def test_compressed_profile_is_bounded_before_json_parsing(self):
        packed = base64.urlsafe_b64encode(zlib.compress(b' ' * 100_000)).decode().rstrip('=')
        with self.assertRaises(gateway.ProtocolError):
            gateway.live_speech_profile({'speechProfile': packed})

    def client(self):
        return TestClient(gateway.app)

    def ticket(self):
        return token({"exp": int(time.time()) + 300, "jti": str(uuid.uuid4())})

    def test_missing_or_wrong_origin_never_opens_authenticated_session(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(gateway, "StreamingASR", ModelBoundary), self.client() as client:
            for headers in ({}, {"origin": "https://evil.example"}):
                with self.subTest(headers=headers), self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect("/ws", headers=headers):
                        pass
            self.assertEqual(client.get("/healthz").json()["activeSessions"], 0)

    def test_ready_final_transcripts_and_ticket_replay_follow_real_socket_protocol(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(gateway, "StreamingASR", ModelBoundary), self.client() as client:
            ticket = self.ticket()
            with client.websocket_connect("/ws", headers={"origin": ENV["ALLOWED_ORIGINS"]}) as socket:
                socket.send_json({"type": "session.start", "token": ticket})
                ready = socket.receive_json()
                self.assertEqual(ready["type"], "session.ready")
                self.assertEqual((ready["sampleRate"], ready["defaultVoice"]), (24000, "zh_1"))
                socket.send_bytes(b"\x00\x00" * 320)
                self.assertEqual(socket.receive_json()["type"], "input.speech.started")
                self.assertEqual(socket.receive_json()["type"], "input.partial")
                socket.send_bytes(b"\x00\x00" * 320)
                final = socket.receive_json()
                self.assertEqual(final["type"], "input.final")
                self.assertTrue(final["id"])
                self.assertEqual(final["text"], "我想先了解交付时间")
            with client.websocket_connect("/ws", headers={"origin": ENV["ALLOWED_ORIGINS"]}) as socket:
                socket.send_json({"type": "session.start", "token": ticket})
                self.assertEqual(socket.receive_json()["type"], "session.error")
            health = client.get("/healthz").json()
            self.assertTrue(health["asr"]["loaded"])
            self.assertEqual(health["tts"]["probe"], "not_performed")
            self.assertIsNone(health["tts"]["lastSynthesis"])

    def test_microphone_input_interrupts_tts_while_pcm_output_is_active(self):
        async def provider(command):
            yield b"\x01\x00" * 240
            await asyncio.Event().wait()

        with patch.dict(os.environ, ENV, clear=True), patch.object(gateway, "StreamingASR", ModelBoundary), patch.object(gateway, "synthesize", provider), self.client() as client:
            with client.websocket_connect("/ws", headers={"origin": ENV["ALLOWED_ORIGINS"]}) as socket:
                socket.send_json({"type": "session.start", "token": self.ticket()})
                socket.receive_json()
                socket.send_json({"type": "output.speak", "id": "customer-1", "text": "请告诉我交付时间", "voice": "zh_1", "rate": 1})
                self.assertEqual(socket.receive_json(), {"type": "output.started", "id": "customer-1"})
                self.assertTrue(socket.receive_bytes())
                socket.send_bytes(b"\x00\x00" * 320)
                self.assertEqual(socket.receive_json(), {"type": "output.cancelled", "id": "customer-1"})
                self.assertEqual(socket.receive_json(), {"type": "input.speech.started"})
                self.assertEqual(socket.receive_json()["type"], "input.partial")

    def test_invalid_pcm_and_unknown_voice_fail_without_provider_requests(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(gateway, "StreamingASR", ModelBoundary), self.client() as client:
            for message in (b"a", {"type": "output.speak", "id": "bad", "text": "你好", "voice": "not-installed"}):
                with self.subTest(message=message), client.websocket_connect("/ws", headers={"origin": ENV["ALLOWED_ORIGINS"]}) as socket:
                    socket.send_json({"type": "session.start", "token": self.ticket()})
                    socket.receive_json()
                    socket.send_bytes(message) if isinstance(message, bytes) else socket.send_json(message)
                    self.assertEqual(socket.receive_json()["code"], "invalid_request")

    def test_late_reply_is_cancelled_if_user_is_already_speaking_again(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(gateway, "StreamingASR", ModelBoundary), self.client() as client:
            with client.websocket_connect("/ws", headers={"origin": ENV["ALLOWED_ORIGINS"]}) as socket:
                socket.send_json({"type": "session.start", "token": self.ticket()})
                socket.receive_json()
                socket.send_bytes(b"\x00\x00" * 320)
                self.assertEqual(socket.receive_json()["type"], "input.speech.started")
                socket.receive_json()
                socket.send_json({"type": "output.speak", "id": "late", "text": "旧一轮的客户回应", "voice": "zh_1", "rate": 1})
                self.assertEqual(socket.receive_json(), {"type": "output.cancelled", "id": "late"})

    def test_asr_runtime_failure_is_reported_without_exposing_provider_details(self):
        class FailingModel(ModelBoundary):
            def accept(self, stream, pcm):
                raise RuntimeError("private model path should never be returned")

        with patch.dict(os.environ, ENV, clear=True), patch.object(gateway, "StreamingASR", FailingModel), self.client() as client:
            with client.websocket_connect("/ws", headers={"origin": ENV["ALLOWED_ORIGINS"]}) as socket:
                socket.send_json({"type": "session.start", "token": self.ticket()})
                socket.receive_json()
                socket.send_bytes(b"\x00\x00" * 320)
                error = socket.receive_json()
                self.assertEqual(error["code"], "gateway_failed")
                self.assertNotIn("private model", str(error))


if __name__ == "__main__":
    unittest.main()
