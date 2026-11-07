# Douyin connection recovery

User asks to investigate recurring disconnects and optimize or restructure the connection. Preserve working acquisition/reply flow, persistent profile/pairing/journal, strict sender proof and unknown-send deduplication.

Evidence: installed assistant matches source. Live panel runs indefinitely in verificationPending while the dedicated browser is logged in on its own SELF profile. Synthetic fixtures confirm a temporary owner-proof failure leaves SELF/cached proof cleared; idle polls never invoke the recovery path that explicit connect invokes.

Implementation:
1. Browser/core expose an explicit recovery probe that reuses the existing identity tab and never navigates the chat. Idle passive checks remain navigation-free. No stale identity authorizes sends.
2. Controller separates liveness and job polling. Independent status heartbeat15s never claims jobs or changes login identity. After15s pending, perform at most2 automatic identity recovery cycles with60s cooldown, then show an actionable manual recheck. Network retries back off, real CAPTCHA/account change stop safely.
3. Add a status API with device/member authentication and liveness-only update. Retain legacy clients.
4. Persist a bounded local diagnostics history of connection state/error categories only; no credentials, account identities, customer messages or external telemetry.
5. Test synthetic failures/recovery, long-job liveness, offline backoff, stop/restart, API authorization and diagnostics privacy. Full suite/types/build, independent review, publish Site preserving audience, sync private CTYX, rebuild and safely update existing Mac app while retaining login data.

Alternatives: verified official enterprise message API currently pauses new applications; other official channels require existing permissions/approved scenario. Retain current bridge, make its recovery deterministic; defer CDP/extension/new browser engine absent lifecycle evidence.
