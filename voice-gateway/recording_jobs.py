"""Authenticated, restart-safe offline transcription; no public audio URLs."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
import subprocess
import time
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from starlette.formparsers import MultiPartException

MAX_UPLOAD = 20 * 1024 * 1024
MAX_DURATION = 2 * 60 * 60
DIALECTS = {"auto", "mandarin", "cantonese", "wu", "min", "hakka", "gan", "xiang", "jin"}


def verify_recording_token(value, secret, now=None):
    now = time.time() if now is None else now
    try:
        if len(secret.encode()) < 32 or not isinstance(value, str) or not value.startswith("Bearer "):
            raise ValueError()
        token = value[7:]
        if len(token) > 8192:
            raise ValueError()
        header, body, signature = token.split(".")
        decode = lambda data: base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
        if json.loads(decode(header)).get("alg") != "HS256":
            raise ValueError()
        expected = hmac.new(secret.encode(), (header + "." + body).encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, decode(signature)):
            raise ValueError()
        claims = json.loads(decode(body))
        if claims.get("aud") != "recording-asr":
            raise ValueError()
        expiry, issued = claims.get("exp"), claims.get("iat")
        if type(expiry) not in (float, int) or type(issued) not in (float, int) or not math.isfinite(expiry) or not now < expiry <= now + 330 or not now - 330 <= issued <= now + 30:
            raise ValueError()
        for key in ("sub", "recordingId", "jti"):
            if not isinstance(claims.get(key), str) or not 0 < len(claims[key]) <= 512:
                raise ValueError()
        return claims
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError) as error:
        raise HTTPException(401, "转写认证无效或已过期") from error


def validate_options(value):
    if not isinstance(value, dict) or len(json.dumps(value, ensure_ascii=False).encode()) > 64_000:
        raise ValueError("识别设置格式无效")
    dialect = value.get("dialect", "auto")
    count = value.get("speakerCount")
    version = value.get("hotwordVersion", 0)
    diarization = value.get("diarization", True)
    if dialect not in DIALECTS or type(diarization) is not bool or (count is not None and (type(count) is not int or not 1 <= count <= 10)) or type(version) is not int or not 0 <= version <= 2**53:
        raise ValueError("方言或讲话人设置不正确")
    hotwords = value.get("hotwords", [])
    if not isinstance(hotwords, list) or len(hotwords) > 50:
        raise ValueError("热词最多50条")
    parsed, words, aliases = [], set(), {}
    for item in hotwords:
        if not isinstance(item, dict) or type(item.get("enabled", True)) is not bool:
            raise ValueError("热词格式不正确")
        term, variants = item.get("term"), item.get("aliases", [])
        if not isinstance(term, str) or not 1 <= len(term.strip()) <= 40 or re.search(r"[\x00-\x1f\x7f,，]", term) or not isinstance(variants, list) or len(variants) > 5:
            raise ValueError("热词或误识别写法格式不正确")
        term = term.strip()
        if term in words:
            raise ValueError("标准词不能重复")
        words.add(term)
        clean = []
        for alias in variants:
            if not isinstance(alias, str) or not 2 <= len(alias.strip()) <= 40 or re.search(r"[\x00-\x1f\x7f]", alias):
                raise ValueError("误识别写法须为2至40字，避免单字误替换")
            alias = alias.strip()
            if alias != term and alias not in clean:
                clean.append(alias)
                if item.get("enabled", True):
                    if alias in aliases and aliases[alias] != term:
                        raise ValueError("同一误识别写法不能对应多个标准词")
                    aliases[alias] = term
        parsed.append({"term": term, "aliases": clean, "enabled": item.get("enabled", True)})
    if any(alias in words and alias != term for alias, term in aliases.items()):
        raise ValueError("误识别写法不能与其他标准词冲突")
    return {"dialect": dialect, "diarization": diarization, "speakerCount": count, "hotwordVersion": version, "hotwords": parsed}


def correct_result(result, options):
    """Explicit aliases only, longest-first single pass, no chained rewriting."""
    replacements = {alias: word["term"] for word in options["hotwords"] if word["enabled"] for alias in word["aliases"]}
    corrections = {}
    if replacements:
        pattern = re.compile("|".join(re.escape(key) for key in sorted(replacements, key=len, reverse=True)))
    else:
        pattern = None

    def correct(text):
        if pattern is None:
            return text
        def replace(match):
            alias = match.group(0)
            # Latin aliases must be whole words, never substrings of an ID.
            if re.search(r"[a-zA-Z0-9]", alias) and ((match.start() and re.match(r"[a-zA-Z0-9_]", text[match.start()-1])) or (match.end() < len(text) and re.match(r"[a-zA-Z0-9_]", text[match.end()]))):
                return alias
            term = replacements[alias]
            corrections[(alias, term)] = corrections.get((alias, term), 0) + 1
            return term
        return pattern.sub(replace, text)

    for segment in result["segments"]:
        segment["rawText"] = segment.get("rawText", segment["text"])
        segment["text"] = correct(segment["rawText"])
    result["rawText"] = "\n".join(segment["rawText"] for segment in result["segments"])
    result["text"] = "\n".join(segment["text"] for segment in result["segments"])
    result["corrections"] = [{"from": before, "to": after, "count": count} for (before, after), count in corrections.items()]
    result["hotwordVersion"] = options["hotwordVersion"]
    return result


def decode_audio(source: Path, target: Path):
    import imageio_ffmpeg
    # Stop at the duration bound plus one sample, rather than decoding arbitrary
    # compressed input into an unbounded file. No shell or remote media URLs.
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(source), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-t", str(MAX_DURATION + 1), "-c:a", "pcm_s16le", "-y", str(target)]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=180)
    except (subprocess.SubprocessError, OSError) as error:
        raise ValueError("录音无法解码，请换成有效的音频文件") from error
    import wave
    with wave.open(str(target), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
        if not 0 < duration <= MAX_DURATION:
            raise ValueError("录音须在2小时以内，请分段后重试")
    return duration


class RecordingJobs:
    def __init__(self, recognizer, directory=None):
        self.recognizer = recognizer
        self.directory = Path(directory or os.environ.get("RECORDING_JOB_DIR", Path(__file__).resolve().parent / "data/transcriptions")).resolve()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        self.database = self.directory / "jobs.sqlite3"
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, recording TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL, message TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL, options TEXT NOT NULL, result TEXT)")
            db.execute("UPDATE jobs SET status='failed', message='语音服务重启中断了转写，请重试' WHERE status='running'")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS recording_active ON jobs(owner,recording) WHERE status IN ('queued','running')")
        os.chmod(self.database, 0o600)
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="recording-asr")
        self.worker = None
        self.reserved = 0
        self.lock = asyncio.Lock()
        self.stopping = threading.Event()

    def connect(self):
        db = sqlite3.connect(self.database, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def owner(sub):
        return hashlib.sha256(sub.encode()).hexdigest()

    def get(self, identifier, claims):
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=? AND owner=? AND recording=?", (identifier, self.owner(claims["sub"]), claims["recordingId"])).fetchone()
        if row is None:
            raise HTTPException(404, "转写任务不存在或无权访问")
        result = {"id": row["id"], "recordingId": row["recording"], "status": row["status"], "progress": row["progress"], "message": row["message"], "createdAt": row["created"], "updatedAt": row["updated"]}
        if row["result"]:
            stored = json.loads(row["result"])
            if row['status'] == 'failed':
                result['errorCode'] = stored.get('errorCode', 'internal')
            else:
                result["result"] = stored
        return result

    def update(self, identifier, **values):
        values["updated"] = time.time()
        with self.connect() as db:
            db.execute("UPDATE jobs SET " + ",".join(key + "=?" for key in values) + " WHERE id=?", (*values.values(), identifier))

    def process(self, row):
        identifier = row["id"]
        source, wav = self.directory / (identifier + ".audio"), self.directory / (identifier + ".wav")
        self.update(identifier, status="running", progress=2, message="正在解码录音")
        try:
            decode_audio(source, wav)
            options = validate_options(json.loads(row["options"]))
            def progress(value, message="正在识别录音"):
                if self.stopping.is_set():
                    raise InterruptedError("Recording service is shutting down")
                self.update(identifier, progress=max(3, min(99, int(3 + 96 * value))), message=str(message)[:100])
            result = correct_result(self.recognizer.transcribe(wav, options, progress), options)
            if not result.get("text", "").strip():
                raise ValueError("未识别到有效讲话，请检查录音内容")
            if len(result["text"]) > 100_000 or len(result["segments"]) > 6000 or len(json.dumps(result, ensure_ascii=False).encode()) > 2_000_000:
                raise ValueError("转写结果过长，请把录音分段后重试")
            self.update(identifier, status="completed", progress=100, message="转写完成", result=json.dumps(result, ensure_ascii=False))
        except Exception as error:
            # Known validation messages are ours; never return native decoder
            # errors, paths, model payloads, audio contents or credentials.
            message = str(error) if isinstance(error, ValueError) and str(error).startswith(("录音", "未识别", "转写结果")) else "转写未完成，请检查模型服务后重试"
            code = ('hotword_budget' if isinstance(error, ValueError) and str(error).startswith('启用热词') else
                    'no_speech' if isinstance(error, ValueError) and str(error).startswith('未识别') else
                    'duration' if isinstance(error, ValueError) and '2小时' in str(error) else
                    'decode' if isinstance(error, ValueError) and str(error).startswith('录音无法解码') else 'internal')
            self.update(identifier, status="failed", message=message, result=json.dumps({'errorCode': code}))
        finally:
            source.unlink(missing_ok=True)
            wav.unlink(missing_ok=True)

    async def run(self):
        loop = asyncio.get_running_loop()
        next_cleanup = time.monotonic() + 3600
        while True:
            if time.monotonic() >= next_cleanup:
                self.cleanup()
                next_cleanup = time.monotonic() + 3600
            with self.connect() as db:
                row = db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
            if row is None:
                await asyncio.sleep(0.5)
                continue
            await loop.run_in_executor(self.executor, self.process, row)

    def start(self):
        self.cleanup()
        self.worker = asyncio.create_task(self.run())

    def cleanup(self):
        cutoff = time.time() - 7 * 86400
        with self.connect() as db:
            rows = db.execute("SELECT id FROM jobs WHERE updated<? AND status IN ('completed','failed')", (cutoff,)).fetchall()
            db.execute("DELETE FROM jobs WHERE updated<? AND status IN ('completed','failed')", (cutoff,))
        for row in rows:
            for suffix in (".audio", ".wav"):
                (self.directory / (row["id"] + suffix)).unlink(missing_ok=True)

    async def close(self):
        self.stopping.set()
        if self.worker:
            self.worker.cancel()
            try:
                await self.worker
            except asyncio.CancelledError:
                pass
        # A native decode is not cancellable; wait before unloading its model.
        await asyncio.to_thread(self.executor.shutdown, wait=True)


router = APIRouter()


@router.get("/speech-capabilities")
async def capabilities(request: Request):
    return request.app.state.recordings.recognizer.capabilities()


@router.get("/transcriptions/{identifier}")
async def get_transcription(identifier: str, request: Request):
    claims = verify_recording_token(request.headers.get("authorization"), request.app.state.settings.secret)
    if not re.fullmatch(r"[0-9a-f]{32}", identifier):
        raise HTTPException(404, "转写任务不存在或无权访问")
    return {"job": request.app.state.recordings.get(identifier, claims)}


@router.post("/transcriptions")
async def create_transcription(request: Request):
    claims = verify_recording_token(request.headers.get("authorization"), request.app.state.settings.secret)
    jobs = request.app.state.recordings
    available = jobs.recognizer.capabilities()
    if not available.get("available"):
        raise HTTPException(503, "录音识别模型尚未部署，请先安装模型")
    # A lost POST response must not create a second in-flight inference.
    with jobs.connect() as db:
        existing = db.execute("SELECT id FROM jobs WHERE owner=? AND recording=? AND status IN ('queued','running') ORDER BY created DESC LIMIT 1", (jobs.owner(claims["sub"]), claims["recordingId"])).fetchone()
    if existing:
        return {"job": jobs.get(existing["id"], claims)}
    advertised = request.headers.get("content-length")
    if advertised and (not advertised.isdecimal() or int(advertised) > MAX_UPLOAD + 64_000):
        raise HTTPException(413, "录音不能超过20MB")
    # Limit streaming multipart bytes before Starlette's spooling parser sees
    # them, including chunked uploads without Content-Length.
    receive = request._receive
    consumed = 0
    async def limited_receive():
        nonlocal consumed
        message = await receive()
        consumed += len(message.get("body", b""))
        if consumed > MAX_UPLOAD + 64_000:
            raise HTTPException(413, "录音不能超过20MB")
        return message
    request._receive = limited_receive
    async with jobs.lock:
        with jobs.connect() as db:
            active = db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
        if active + jobs.reserved >= 8:
            raise HTTPException(429, "转写队列已满，请稍后重试")
        jobs.reserved += 1
    identifier = uuid.uuid4().hex
    destination = jobs.directory / (identifier + ".audio")
    try:
        async with request.form(max_files=1, max_fields=1, max_part_size=64_000) as form:
            file, raw = form.get("file"), form.get("options", "{}")
            if set(form.keys()) - {"file", "options"} or len(form.getlist("file")) != 1 or len(form.getlist("options")) > 1 or not hasattr(file, "read") or not isinstance(raw, str) or len(raw.encode()) > 64_000:
                raise HTTPException(400, "录音及识别参数不正确")
            try:
                options = validate_options(json.loads(raw))
            except (ValueError, TypeError) as error:
                raise HTTPException(400, "识别设置不正确，请检查热词和讲话人数") from error
            request.app.state.tickets.consume(claims["jti"], claims["exp"], time.time())
            size = 0
            with destination.open("xb") as output:
                os.chmod(destination, 0o600)
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(413, "录音不能超过20MB")
                    output.write(chunk)
            if not size:
                raise HTTPException(400, "录音文件为空")
        now = time.time()
        try:
            with jobs.connect() as db:
                db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,NULL)", (identifier, jobs.owner(claims["sub"]), claims["recordingId"], "queued", 0, "等待识别", now, now, json.dumps(options, ensure_ascii=False)))
        except sqlite3.IntegrityError:
            destination.unlink(missing_ok=True)
            with jobs.connect() as db:
                existing = db.execute("SELECT id FROM jobs WHERE owner=? AND recording=? AND status IN ('queued','running')", (jobs.owner(claims["sub"]), claims["recordingId"])).fetchone()
            if existing:
                return {"job": jobs.get(existing["id"], claims)}
            raise
        return {"job": jobs.get(identifier, claims)}
    except (MultiPartException, ValueError) as error:
        destination.unlink(missing_ok=True)
        raise HTTPException(400, "录音上传格式不正确") from error
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    finally:
        async with jobs.lock:
            jobs.reserved -= 1
