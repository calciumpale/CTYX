# Duplex voice implementation plan

> For agentic workers: execute the independent client, gateway and integration tasks in parallel; review and verify the combined result before publishing.

**Goal:** Automatically submit spoken training turns, support a real simultaneous input/output connection to a self-hosted gateway, and select voices actually provided by that service.

**Architecture:** Browser AudioWorklet continuously sends 16 kHz PCM with browser echo cancellation over authenticated WSS. An independent Python gateway performs streaming sherpa-onnx recognition and OpenAI-compatible PCM synthesis. The existing training_reply action remains the sole source of saved customer responses; no second model creates duplicate replies.

**Tech stack:** React, Cloudflare Worker/D1, Web Audio, WebSocket, Python FastAPI, sherpa-onnx, selectable self-hosted TTS.

**Spec:** User's three voice requirements and explicit choice of a self-hosted open source gateway.

## Global constraints

- No service is shown as connected before a successful handshake.
- Credentials stay on the server; browser receives a five-minute, session-scoped token.
- Preserve the private site's audience, existing roles and five domain agents.
- Keep browser compatibility speech clearly labeled as turn-taking rather than full duplex.

## Review focus

- Final transcripts arriving while a mutation is pending must queue without loss or duplicate submission.
- Switching sessions, ending practice or hiding the page must release capture and discard stale callbacks.
- Barge-in cancels queued client audio and upstream synthesis without stopping capture.
- Cross-origin connections, replayed/expired tokens and oversized messages must fail clearly.
- Unconfigured gateways and failed TTS must never be presented as available voices or successful audio.

## Tasks

- [x] Client: AudioWorklet capture, bounded playback, protocol controller, lifecycle tests.
- [x] Gateway: authenticated WSS, streaming ASR, cancellable PCM TTS, Docker and protocol tests.
- [x] Integration: server token endpoint, automatic serial submission, full duplex UI, browser auto-submit compatibility.
- [x] Delivery preparation: deployment guide, typecheck/tests/token audit/build, visual QA and independent review. Publish the prepared source to the existing private Site with the hosting workflow.
