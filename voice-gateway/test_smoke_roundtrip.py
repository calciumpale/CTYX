import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

import httpx

import smoke_roundtrip


class SmokeRoundtripTests(unittest.IsolatedAsyncioTestCase):
    async def run_smoke(self, **options):
        requests = []
        sent = []
        gateway_calls = []
        messages = [{"role": "assistant", "content": "（演示客户）您好，我想谈一下装修期间的租金。"}]
        session = {"id": "synthetic-session", "messages": messages}

        def api(request):
            requests.append(request)
            if request.method == "GET":
                return httpx.Response(200, json={"revision": 7})
            body = json.loads(request.content)
            if request.url.path == "/api/training-voice":
                self.assertEqual(body, {"sessionId": "synthetic-session"})
                return httpx.Response(200, json={"url": "wss://configured.invalid/ws", "token": "ephemeral-test-ticket"})
            self.assertEqual(body["revision"], 7)
            if body["action"] == "training_start":
                payload = body["payload"]
                self.assertIs(payload.get("confirmed"), True)
                self.assertIn("免租期", payload["scenario"])
                profile = payload.get("profile", {})
                limits = {"name": 60, "industry": 100, "role": 100, "need": 600, "budget": 160, "timeline": 160,
                          "decisionMode": 40, "communicationStyle": 40, "concern": 600, "difficulty": 20}
                self.assertEqual(set(profile), set(limits))
                for field, limit in limits.items():
                    self.assertIsInstance(profile[field], str)
                    self.assertTrue(profile[field].strip())
                    self.assertLessEqual(len(profile[field]), limit)
                self.assertIn("合成", profile["name"])
                self.assertIn("45", profile["timeline"])
                self.assertIn("两个月", profile["timeline"])
                self.assertEqual(profile["decisionMode"], "与合伙人共同决策")
                self.assertEqual(profile["communicationStyle"], "谨慎细致")
                self.assertEqual(profile["difficulty"], "进阶")
            elif body["action"] == "training_reply":
                self.assertEqual(body["payload"], {"sessionId": "synthetic-session", "text": "关于免租期，我想了解入住时间和装修计划。", "voiceTurnId": "duplex:synthetic-turn"})
                if len(messages) == 1:
                    messages.extend([{"role": "user", "content": body["payload"]["text"]},
                                     {"role": "assistant", "content": "（演示客户）我们预计两个月后开业，装修需要45天。"}])
            elif body["action"] == "training_finish":
                self.assertEqual(body["payload"], {"sessionId": "synthetic-session"})
            else:
                self.fail("Unexpected workbench action")
            return httpx.Response(200, json={"session": session})

        class Socket:
            def __init__(self):
                self.events = iter([
                    json.dumps({"type": "session.ready", "voices": [{"id": "speaker-48"}], "defaultVoice": "speaker-48"}),
                    b"\x00\x00",
                    json.dumps({"type": "input.speech.started"}),
                    json.dumps({"type": "output.cancelled"}),
                    json.dumps({"type": "input.final", "id": "synthetic-turn", "text": "关于免租期，我想了解入住时间和装修计划。"}),
                    b"\x01\x00" * 240,
                    json.dumps({"type": "output.finished"}),
                ])

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def recv(self):
                return next(self.events)

            async def send(self, message):
                if isinstance(message, str):
                    sent.append(json.loads(message))

        def connect(url, **kwargs):
            gateway_calls.append((url, kwargs))
            return Socket()

        client = httpx.AsyncClient
        async def immediate_sleep(_):
            pass

        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / "synthetic.wav"
            with wave.open(str(wav), "wb") as audio:
                audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                audio.writeframes(bytes(320))
            with patch.object(smoke_roundtrip.httpx, "AsyncClient", side_effect=lambda **kwargs: client(transport=httpx.MockTransport(api), **kwargs)), \
                 patch.object(smoke_roundtrip.websockets, "connect", side_effect=connect), \
                 patch.object(smoke_roundtrip.asyncio, "sleep", immediate_sleep), patch("builtins.print"):
                await smoke_roundtrip.main(wav, directory, "offline-test", **options)
            report = json.loads((Path(directory) / "roundtrip.json").read_text())

        self.assertEqual(report["result"], "passed")
        self.assertTrue(report["customerPlaybackCancelledOnSpeech"])
        self.assertEqual(report["savedUserTurns"], 1)
        self.assertEqual(sent[0], {"type": "session.start", "token": "ephemeral-test-ticket"})
        self.assertEqual([event["text"] for event in sent if event["type"] == "output.speak"], [
            "您好，我想谈一下装修期间的租金。", "我们预计两个月后开业，装修需要45天。",
        ])
        actions = [json.loads(request.content)["action"] for request in requests if request.url.path == "/api/workbench" and request.method == "POST"]
        self.assertEqual(actions, ["training_start", "training_reply", "training_reply", "training_finish"])
        return requests, gateway_calls

    async def test_confirmed_synthetic_persona_roundtrip_uses_local_worker_ticket(self):
        requests, gateway_calls = await self.run_smoke()
        self.assertTrue(all(str(request.url).startswith("http://127.0.0.1:5173/") for request in requests))
        self.assertTrue(all(request.headers["origin"] == "http://127.0.0.1:5173" for request in requests))
        self.assertTrue(all(request.headers["cookie"] == "__sites_local_auth=1; ctai_experience_role=sales" for request in requests))
        self.assertEqual(gateway_calls, [("wss://configured.invalid/ws", {"origin": "http://127.0.0.1:5173", "max_size": 128 * 1024, "proxy": None})])

    async def test_public_wss_override_keeps_local_api_identity_and_origin(self):
        requests, gateway_calls = await self.run_smoke(root="http://127.0.0.1:5999", gateway_url="wss://public.invalid/ws", origin="https://workbench.invalid")
        self.assertTrue(all(str(request.url).startswith("http://127.0.0.1:5999/") for request in requests))
        self.assertTrue(all(request.headers["origin"] == "http://127.0.0.1:5999" for request in requests))
        self.assertTrue(all(request.headers["cookie"] == "__sites_local_auth=1; ctai_experience_role=sales" for request in requests))
        self.assertEqual(gateway_calls[0][0], "wss://public.invalid/ws")
        self.assertEqual(gateway_calls[0][1]["origin"], "https://workbench.invalid")


if __name__ == "__main__":
    unittest.main()
