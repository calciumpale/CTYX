"""Run with python -m unittest -v; no ASR weights or network required."""
import asyncio
import base64
import hashlib
import hmac
import json
import unittest

from gateway_core import AudioBudget, OutputChannel, ProtocolError, ReplayCache, parse_command, verify_token


SECRET = "testing-key-with-at-least-32-bytes!"


def token(changes=None, *, algorithm="HS256", secret=SECRET):
    claims = {"aud": "training-voice", "sub": "user-1", "sessionId": "session-1", "exp": 1300, "jti": "ticket-1"}
    claims.update(changes or {})
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=")
    body = encode({"alg": algorithm, "typ": "JWT"}) + b"." + encode(claims)
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).rstrip(b"=")
    return (body + b"." + signature).decode()


class AuthTests(unittest.TestCase):
    def test_signed_ticket_binds_user_and_session_and_cannot_be_replayed(self):
        cache = ReplayCache(2)
        claims = verify_token(token(), SECRET, cache, now=1000)
        self.assertEqual((claims["sub"], claims["sessionId"]), ("user-1", "session-1"))
        with self.assertRaises(ProtocolError):
            verify_token(token(), SECRET, cache, now=1001)

    def test_rejects_wrong_signature_algorithm_audience_and_expiry(self):
        candidates = [token(secret="wrong"), token(algorithm="none"), token({"aud": "other"}), token({"exp": 999}), token({"exp": 1601}), token({"exp": True}), token({"sessionId": ""}), "invalid"]
        for candidate in candidates:
            with self.subTest(candidate=candidate[:20]), self.assertRaises(ProtocolError):
                verify_token(candidate, SECRET, ReplayCache(10), now=1000)

    def test_cache_fails_closed_when_full_and_reclaims_only_expired_tickets(self):
        cache = ReplayCache(1)
        verify_token(token({"exp": 1010}), SECRET, cache, now=1000)
        with self.assertRaises(ProtocolError):
            verify_token(token({"jti": "ticket-2"}), SECRET, cache, now=1001)
        verify_token(token({"jti": "ticket-3", "exp": 1200}), SECRET, cache, now=1011)

    def test_missing_short_secret_does_not_accept_any_token(self):
        for secret in ("", "short"):
            with self.assertRaises(ProtocolError):
                verify_token(token(secret=secret), secret, ReplayCache(2), now=1000)


class ProtocolTests(unittest.TestCase):
    def test_only_configured_voice_and_bounded_text_are_accepted(self):
        voices = {"zh_1"}
        command = parse_command(json.dumps({"type": "output.speak", "id": "a", "text": " 您好 ", "voice": "zh_1", "rate": 1.1}), voices)
        self.assertEqual(command["text"], "您好")
        for change in ({"voice": "unconfigured"}, {"text": ""}, {"text": "a" * 4001}, {"rate": 0}, {"rate": True}, {"id": ""}):
            value = {**command, **change}
            with self.subTest(change=change), self.assertRaises(ProtocolError):
                parse_command(json.dumps(value), voices)

    def test_invalid_json_type_and_oversize_control_are_rejected(self):
        for data in ("[]", "{", "null", '{"type":"unknown"}', " " * 16385):
            with self.subTest(data=data[:30]), self.assertRaises(ProtocolError):
                parse_command(data, {"zh_1"})
        self.assertEqual(parse_command('{"type":"output.cancel"}', set())["type"], "output.cancel")

    def test_pcm_length_and_input_budget_fail_closed(self):
        budget = AudioBudget(now=0)
        for size in (0, 1, 16386):
            with self.subTest(size=size), self.assertRaises(ProtocolError):
                budget.consume(b"a" * size, now=0)
        for _ in range(4):
            budget.consume(b"a" * 16000, now=0)
        with self.assertRaises(ProtocolError):
            budget.consume(b"aa", now=0)
        budget.consume(b"aa", now=1)


class OutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_fast_provider_thirty_seconds_audio_stays_within_three_hundred_ms_lead(self):
        clock = [0.0]
        samples_sent = [0]
        leads = []

        async def send(value):
            if isinstance(value, bytes):
                samples_sent[0] += len(value)
                leads.append(samples_sent[0] / 48000 - clock[0])

        async def synthesize(command):
            yield b"\x00" * 48000 * 30

        async def sleep(delay):
            clock[0] += delay
            await asyncio.sleep(0)

        output = OutputChannel(send, synthesize, clock=lambda: clock[0], sleep=sleep)
        await output.speak({"id": "thirty-seconds"})
        await output.wait()
        self.assertEqual(samples_sent[0], 48000 * 30)
        self.assertLessEqual(max(leads), 0.300001)
        self.assertGreaterEqual(clock[0], 29.6999)

    async def test_cancel_joins_old_stream_before_next_started_and_closes_generator(self):
        events = []
        first_chunk_sent = asyncio.Event()
        blocked = asyncio.Event()
        closed = []

        async def send(value):
            events.append(value)
            if isinstance(value, bytes):
                first_chunk_sent.set()

        async def synthesize(command):
            try:
                yield command["id"].encode() * 2
                if command["id"] == "old":
                    await blocked.wait()
            finally:
                closed.append(command["id"])

        output = OutputChannel(send, synthesize)
        await output.speak({"id": "old"})
        await asyncio.wait_for(first_chunk_sent.wait(), 1)
        await output.speak({"id": "new"})
        await output.wait()
        self.assertIn("old", closed)
        cancelled = events.index({"type": "output.cancelled", "id": "old"})
        started = events.index({"type": "output.started", "id": "new"})
        self.assertLess(cancelled, started)
        self.assertNotIn(b"oldold", events[started:])
        self.assertEqual(events[-1], {"type": "output.finished", "id": "new"})

    async def test_partial_pcm_bytes_are_reassembled_and_never_emit_odd_frames(self):
        events = []

        async def send(value):
            events.append(value)

        async def synthesize(command):
            for chunk in (b"a", b"bcd", b"e", b"f"):
                yield chunk

        output = OutputChannel(send, synthesize)
        await output.speak({"id": "one"})
        await output.wait()
        audio = [event for event in events if isinstance(event, bytes)]
        self.assertEqual(b"".join(audio), b"abcdef")
        self.assertTrue(all(len(chunk) % 2 == 0 for chunk in audio))

    async def test_empty_or_malformed_provider_audio_is_reported_without_false_success(self):
        for chunks in ([], [b"a"]):
            events = []

            async def send(value):
                events.append(value)

            async def synthesize(command):
                for chunk in chunks:
                    yield chunk

            output = OutputChannel(send, synthesize)
            await output.speak({"id": "bad"})
            await output.wait()
            self.assertFalse(any(isinstance(event, dict) and event["type"] == "output.finished" for event in events))
            self.assertTrue(any(isinstance(event, dict) and event["type"] == "session.error" for event in events))

    async def test_input_speech_cancellation_can_run_while_tts_is_waiting_for_provider(self):
        events = []

        async def send(value):
            events.append(value)

        async def synthesize(command):
            await asyncio.Event().wait()
            yield b"aa"

        output = OutputChannel(send, synthesize)
        await output.speak({"id": "waiting"})
        await asyncio.sleep(0)
        await asyncio.wait_for(output.cancel(), 1)
        self.assertEqual(events[-1], {"type": "output.cancelled", "id": "waiting"})


if __name__ == "__main__":
    unittest.main()
