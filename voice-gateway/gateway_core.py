"""Protocol, authentication and cancellation; independent of speech libraries."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import math
import time
from contextlib import suppress

MAX_CONTROL_BYTES = 16_384
MAX_PCM_BYTES = 16_384


class ProtocolError(ValueError):
    pass


class ReplayCache:
    """Single-process ticket cache. Never evict unexpired tickets to make room."""

    def __init__(self, capacity=10_000):
        self.capacity = capacity
        self.tickets = {}

    def consume(self, ticket, expiry, now):
        self.tickets = {key: end for key, end in self.tickets.items() if end > now}
        if ticket in self.tickets:
            raise ProtocolError("连接票据已使用，请重新连接")
        if len(self.tickets) >= self.capacity:
            raise ProtocolError("语音服务繁忙，请稍后重试")
        self.tickets[ticket] = expiry


def _decode(value):
    if not value or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for char in value):
        raise ValueError("invalid base64url")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_token(token, secret, replay_cache, *, now=None):
    now = time.time() if now is None else now
    if len(secret.encode()) < 32:
        raise ProtocolError("语音服务认证尚未配置")
    try:
        if not isinstance(token, str) or len(token) > 16_000:
            raise ValueError("invalid ticket")
        header, body, signature = token.split(".")
        metadata = json.loads(_decode(header))
        if not isinstance(metadata, dict) or metadata.get("alg") != "HS256":
            raise ValueError("invalid algorithm")
        expected = hmac.new(secret.encode(), (header + "." + body).encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _decode(signature)):
            raise ValueError("invalid signature")
        claims = json.loads(_decode(body))
        if not isinstance(claims, dict) or claims.get("aud") != "training-voice":
            raise ValueError("invalid audience")
        expiry = claims.get("exp")
        if type(expiry) not in (int, float) or not math.isfinite(expiry) or not now < expiry <= now + 330:
            raise ValueError("expired or excessive ticket lifetime")
        for name in ("sub", "sessionId", "jti"):
            if not isinstance(claims.get(name), str) or not 0 < len(claims[name]) <= 512:
                raise ValueError("invalid binding")
        if "nbf" in claims and (type(claims["nbf"]) not in (int, float) or claims["nbf"] > now):
            raise ValueError("not yet valid")
    except (ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError) as error:
        raise ProtocolError("连接票据无效或已过期，请重新连接") from error
    replay_cache.consume(claims["jti"], expiry, now)
    return claims


def parse_json(raw):
    if not isinstance(raw, str) or len(raw.encode()) > MAX_CONTROL_BYTES:
        raise ProtocolError("控制消息过大")
    try:
        result = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise ProtocolError("控制消息必须为JSON对象") from error
    if not isinstance(result, dict):
        raise ProtocolError("控制消息必须为JSON对象")
    return result


def parse_command(raw, voices):
    command = parse_json(raw)
    if command.get("type") == "output.cancel":
        return {"type": "output.cancel"}
    if command.get("type") != "output.speak":
        raise ProtocolError("不支持的语音控制消息")
    if not isinstance(command.get("id"), str) or not 0 < len(command["id"]) <= 160:
        raise ProtocolError("语音消息编号无效")
    if not isinstance(command.get("text"), str) or not command["text"].strip() or len(command["text"]) > 4000:
        raise ProtocolError("播报文字须为1至4000字")
    if not isinstance(command.get("voice"), str) or command["voice"] not in voices:
        raise ProtocolError("该音色未在自部署服务中配置")
    rate = command.get("rate", 1)
    if type(rate) not in (int, float) or not math.isfinite(rate) or not 0.75 <= rate <= 1.25:
        raise ProtocolError("语速须介于0.75与1.25之间")
    return {"type": "output.speak", "id": command["id"], "text": command["text"].strip(), "voice": command["voice"], "rate": rate}


class AudioBudget:
    """16kHz PCM16 mono: allow normal realtime audio plus one second burst."""

    def __init__(self, *, now=None):
        self.updated = time.monotonic() if now is None else now
        self.tokens = 64_000.0

    def consume(self, data, *, now=None):
        if not isinstance(data, bytes) or not data or len(data) % 2 or len(data) > MAX_PCM_BYTES:
            raise ProtocolError("音频须为16kHz单声道PCM16LE，每帧不超过16384字节")
        now = time.monotonic() if now is None else now
        self.tokens = min(64_000, self.tokens + max(0, now - self.updated) * 40_000)
        self.updated = now
        if len(data) > self.tokens:
            raise ProtocolError("音频发送过快，请重新连接")
        self.tokens -= len(data)


class OutputChannel:
    """One TTS task per socket. cancel() drains it before another can start."""

    def __init__(self, send, synthesize, *, clock=None, sleep=None):
        self.send = send
        self.synthesize = synthesize
        self.task = None
        self.clock = clock or time.monotonic
        self.sleep = sleep or asyncio.sleep

    async def speak(self, command):
        await self.cancel()
        self.task = asyncio.create_task(self._run(command))

    async def wait(self):
        if self.task:
            await self.task

    async def cancel(self):
        previous, self.task = self.task, None
        if previous:
            previous.cancel()
            with suppress(asyncio.CancelledError):
                await previous

    async def _run(self, command):
        message_id = command["id"]
        source = None
        try:
            await self.send({"type": "output.started", "id": message_id})
            source = self.synthesize(command)
            pending, total = b"", 0
            playback_start = None
            async for chunk in source:
                if not isinstance(chunk, bytes):
                    raise ProtocolError("TTS返回了无效音频")
                pending += chunk
                while len(pending) >= 2:
                    size = min(4800, len(pending) - len(pending) % 2)
                    if playback_start is None:
                        playback_start = self.clock()
                    # Bound queued audio so speech-start/cancel is never trapped
                    # behind seconds of PCM in the same WebSocket send buffer.
                    delay = total / 48_000 - (self.clock() - playback_start) - 0.2
                    if delay > 0:
                        await self.sleep(delay)
                    await self.send(pending[:size])
                    total += size
                    pending = pending[size:]
            if pending or not total:
                raise ProtocolError("TTS未返回有效PCM音频")
            await self.send({"type": "output.finished", "id": message_id})
        except asyncio.CancelledError:
            with suppress(Exception):
                await self.send({"type": "output.cancelled", "id": message_id})
            raise
        except Exception:
            # Never expose provider response bodies, keys, URLs or raw customer audio.
            with suppress(Exception):
                await self.send({"type": "session.error", "code": "tts_failed", "id": message_id, "message": "自部署语音合成失败，请检查服务日志或切换文字带练"})
                await self.send({"type": "output.cancelled", "id": message_id})
        finally:
            if source is not None:
                with suppress(Exception):
                    await source.aclose()
