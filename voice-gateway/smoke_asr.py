"""Send an existing WAV through the real local WebSocket; never opens a mic."""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import time
import uuid
import wave
from pathlib import Path

import numpy as np
import websockets
from dotenv import dotenv_values


def ticket(secret):
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=")
    message = encode({"alg": "HS256", "typ": "JWT"}) + b"." + encode({"aud": "training-voice", "sub": "local-smoke", "sessionId": "local-asr-smoke", "exp": int(time.time()) + 300, "jti": str(uuid.uuid4())})
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), message, hashlib.sha256).digest()).rstrip(b"=")
    return (message + b"." + signature).decode()


def wav_pcm(path):
    with wave.open(str(path), "rb") as audio:
        if audio.getsampwidth() != 2:
            raise ValueError("Smoke WAV must contain PCM16 samples")
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").reshape(-1, audio.getnchannels()).mean(axis=1)
        source_rate = audio.getframerate()
    if source_rate != 16000:
        positions = np.arange(int(len(samples) * 16000 / source_rate)) * source_rate / 16000
        samples = np.interp(positions, np.arange(len(samples)), samples)
    # Tail silence lets the real online recognizer emit its endpoint/final.
    return samples.astype("<i2").tobytes() + b"\x00\x00" * 16000 * 2


async def run(args):
    config = dotenv_values(args.env)
    token = ticket(config["VOICE_GATEWAY_SECRET"])
    pcm = wav_pcm(args.wav)
    events = []
    started = time.monotonic()
    async with websockets.connect(args.url, origin=args.origin, max_size=131072, proxy=None) as socket:
        await socket.send(json.dumps({"type": "session.start", "token": token}))
        ready = json.loads(await socket.recv())
        if ready.get("type") != "session.ready":
            raise RuntimeError("Gateway did not authenticate: " + str(ready))

        async def receive():
            async for message in socket:
                if isinstance(message, str):
                    event = json.loads(message)
                    if event["type"] == "session.error":
                        raise RuntimeError(str(event))
                    events.append(event)

        receiver = asyncio.create_task(receive())
        for position in range(0, len(pcm), 3200):
            await socket.send(pcm[position:position + 3200])
            await asyncio.sleep(max(0, started + (position + 3200) / 32000 - time.monotonic()))
        await asyncio.sleep(0.5)
        receiver.cancel()
        try:
            await receiver
        except asyncio.CancelledError:
            pass
    finals = [event for event in events if event["type"] == "input.final"]
    if not finals or not all(event.get("text") for event in finals):
        raise RuntimeError("The actual ASR returned no final transcript")
    result = {"wav": str(args.wav.resolve()), "transport": args.url, "audioSecondsWithTail": round(len(pcm) / 32000, 3), "elapsedSeconds": round(time.monotonic() - started, 3), "speechStartedEvents": sum(event["type"] == "input.speech.started" for event in events), "partialEvents": sum(event["type"] == "input.partial" for event in events), "finals": finals, "tts": "not_tested"}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wav", type=Path, default=Path("models/asr/test_wavs/0.wav"))
    parser.add_argument("--env", type=Path, default=Path(".env"))
    parser.add_argument("--url", default="ws://127.0.0.1:8001/ws")
    parser.add_argument("--origin", default="http://127.0.0.1:5173")
    parser.add_argument("--output", type=Path, default=Path("models/asr-smoke.json"))
    asyncio.run(run(parser.parse_args()))
