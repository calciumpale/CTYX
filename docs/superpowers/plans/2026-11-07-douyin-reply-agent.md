# Douyin reply agent implementation

Implement the reviewed customer brief using the existing TypeScript/D1 service and the working local assistant. Preserve transport identity proof, reliable snapshots, unknown-send reconciliation, manual takeover, contact validation, account/member isolation and all existing product flows.

## Decisions

- Persist six explicit customer needs, contact capture/refusal state and business stage. Treat unconfirmed appointment intent as a need, not a booked appointment.
- Close explicit opt-outs durably across campaigns for the same owner/sender/recipient. Never automatically reopen.
- Managed document knowledge is available only from explicitly selected external-use libraries. Default selection is empty; preserve existing approved legacy source filtering.
- Auto replies use Shanghai 08:30–21:30, independent daily reply budget30 (configurable1–80), rolling24h perconversation12 (1–30). Keep greeting budget and shared60-second send interval. Manual replies remain explicit user actions; opt-out still blocks them.
- Replies are at most60 characters, ask one need at a time, avoid repeated contact requests. Factual statements retain source conditions and exact evidence validation; unsupported facts and commercial/legal commitments transfer to a human.
- Software tests use synthetic messages and isolated browser fixtures. No real private messages are sent.

## Work

1. Policy/agent: normalized settings and memory, explicit extraction, refusal, natural safe fallback, evidence and PII protection, regression tests.
2. Storage/service: additive migration, atomic memory and opt-out, queue/claim/lease gates, scoped settings and independent budgets, integration tests.
3. UI: compact task settings, selected external-use libraries, six customer needs and closed reason; preserve drafts and control sizes.
4. Runtime: managed hybrid retrieval with explicit library allowlist and owner isolation, tests.
5. Verify full suite/types/build, review interactions, publish existing Site preserving audience and sync private CTYX repository.
