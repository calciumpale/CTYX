import base64
import hashlib
import hmac
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from gateway_core import ReplayCache
from recording_jobs import RecordingJobs, correct_result, router, validate_options, verify_recording_token

SECRET = "recording-test-secret-" * 3


def bearer(subject="owner-a", recording="recording-one", **extra):
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    body = encode({"alg": "HS256"}) + "." + encode({"aud": "recording-asr", "sub": subject, "recordingId": recording, "iat": int(time.time()), "exp": int(time.time()) + 300, "jti": str(time.time_ns()), **extra})
    signature = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return "Bearer " + body + "." + signature


class Recognizer:
    def capabilities(self):
        return {"available": True, "model": "test"}

    def transcribe(self, path, options, progress):
        progress(40, "正在区分讲话人")
        return {"text": "先试用客厅系统", "rawText": "先试用客厅系统", "segments": [{"start": 1.0, "end": 2.2, "speaker": "speaker-1", "text": "先试用客厅系统"}], "speakers": [{"id": "speaker-1", "label": "讲话人 1"}], "model": "test", "durationSeconds": 3, "diarization": True, "dialectHint": "auto"}


class OptionsTests(unittest.TestCase):
    def test_tokens_bind_identity_recording_audience_and_time(self):
        claims = verify_recording_token(bearer(), SECRET)
        self.assertEqual((claims["sub"], claims["recordingId"]), ("owner-a", "recording-one"))
        for token in (bearer(aud="training-voice"), bearer(exp=1), bearer(iat=int(time.time())+50), bearer()+"x", "Bearer missing"):
            with self.subTest(token=token[:20]), self.assertRaises(HTTPException):
                verify_recording_token(token, SECRET)

    def test_explicit_aliases_only_longest_first_no_chain_and_latin_boundaries(self):
        options = validate_options({"hotwords": [{"term": "客擎", "aliases": ["客厅系统", "客厅"], "enabled": True}, {"term": "CRM", "aliases": ["crn"], "enabled": True}]})
        raw = "客厅系统客厅 crn xcrn1"
        result = correct_result({"segments": [{"text": raw}]}, options)
        self.assertEqual(result["text"], "客擎客擎 CRM xcrn1")
        self.assertEqual(result["rawText"], raw)
        self.assertEqual(sum(item["count"] for item in result["corrections"]), 3)

    def test_reject_ambiguous_single_character_alias_and_unbounded_options(self):
        for value in ({"hotwords": [{"term": "产品", "aliases": ["产"]}]}, {"hotwords": [{"term": "产品A", "aliases": ["产品B"]}, {"term": "产品B", "aliases": []}]}, {"speakerCount": True}, {"speakerCount": 11}, {"dialect": "invented"}, {"hotwords": [dict(term=str(i), aliases=[]) for i in range(51)]}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_options(value)


class JobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.jobs = RecordingJobs(Recognizer(), self.temp.name)
        app = FastAPI()
        app.state.recordings = self.jobs
        app.state.settings = SimpleNamespace(secret=SECRET)
        app.state.tickets = ReplayCache()
        app.include_router(router)
        self.client = TestClient(app)

    def tearDown(self):
        self.jobs.executor.shutdown(wait=True)
        self.temp.cleanup()

    def upload(self, **overrides):
        return self.client.post("/transcriptions", headers={"Authorization": bearer(**overrides)}, files={"file": ("call.wav", b"example-audio", "audio/wav")}, data={"options": json.dumps({"hotwords": [{"term": "客擎", "aliases": ["客厅系统"], "enabled": True}], "hotwordVersion": 3})})

    def test_submit_process_scope_and_audio_cleanup(self):
        response = self.upload()
        self.assertEqual(response.status_code, 200, response.text)
        identifier = response.json()["job"]["id"]
        with self.jobs.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (identifier,)).fetchone()
        with patch("recording_jobs.decode_audio", return_value=3):
            self.jobs.process(row)
        complete = self.client.get("/transcriptions/"+identifier, headers={"Authorization": bearer()})
        self.assertEqual(complete.json()["job"]["status"], "completed")
        self.assertEqual(complete.json()["job"]["result"]["text"], "先试用客擎")
        self.assertFalse((Path(self.temp.name)/(identifier+".audio")).exists())
        for claims in ({"subject": "owner-b"}, {"recording": "another-recording"}):
            self.assertEqual(self.client.get("/transcriptions/"+identifier, headers={"Authorization": bearer(**claims)}).status_code, 404)

    def test_decode_failure_is_safe_and_retry_keeps_private_files_bounded(self):
        identifier = self.upload().json()["job"]["id"]
        with self.jobs.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (identifier,)).fetchone()
        with patch("recording_jobs.decode_audio", side_effect=RuntimeError("secret provider body")):
            self.jobs.process(row)
        result = self.jobs.get(identifier, {"sub": "owner-a", "recordingId": "recording-one"})
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("secret", result["message"])
        self.assertFalse((Path(self.temp.name)/(identifier+".audio")).exists())

    def test_unauthenticated_and_oversized_uploads_never_store_audio(self):
        self.assertEqual(self.client.post("/transcriptions").status_code, 401)
        self.assertEqual(self.client.post("/transcriptions", headers={"Authorization": bearer(), "Content-Length": str(21*1024*1024)}).status_code, 413)
        self.assertEqual(list(Path(self.temp.name).glob("*.audio")), [])


if __name__ == "__main__":
    unittest.main()
