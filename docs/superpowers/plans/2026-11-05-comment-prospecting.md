# Comment Prospecting Implementation Plan

> **For agentic workers:** Implement the bounded task assigned by the parent; keep shared interfaces in prospecting-types.ts. Use meaningful failing tests before behavior changes.

**Goal:** Deliver requirement-based competitor discovery, comment intake, optional review and queued greetings in the existing workbench.

**Architecture:** D1 stores campaigns, comments, jobs and hashed device credentials. A local browser executor polls a scoped queue and reports observed results. Sender attempts are durable and never automatically replayed after uncertain outcomes.

**Tech Stack:** React, TypeScript, Vinext, Cloudflare D1, Node browser executor.

**Spec:** docs/superpowers/specs/2026-11-05-comment-prospecting-design.md

## Global Constraints

- Reuse incumbent visual tokens; no left accent bars.
- Preserve tenant/member isolation and existing routes.
- No copied MediaCrawler code or inferred identities from anonymous exports.
- No real messages during development tests.

## Review Focus

- Stale approval must not enqueue changed text.
- Parallel workers must not send twice; expired send leases become unknown.
- Paused campaigns or disabled/changed sender accounts cannot start queued sends.
- Anonymous IDs and model output cannot create contactable identity.
- UI must show offline, empty, error, unknown and partial results accurately.

### Task 1: Domain, D1 store and API
- [x] Test validation, normalization, approval CAS, deduplication, permission boundaries and queue leases.
- [x] Implement prospecting-types/domain/store/service, D1 migration and API routes.
- [x] Wire member route access and model integration; verify tests.

### Task 2: Local browser executor
- [x] Test dispatch journal and normalization; implement scoped polling, heartbeat and result retry.
- [x] Implement visible-page discovery, comment reading and single-attempt message submission, with login/challenge failure states.
- [x] Document local setup and MediaCrawler export limits.

### Task 3: Workspace UI
- [x] Add requirement form, editable keywords, candidate selection, comment review, status filters, pause/resume, device pairing and task history.
- [x] Wire navigation and preserve mobile density.
- [x] Verify typecheck and keyboard/empty/error states.

### Task 4: Integration and release
- [x] Run full tests, typecheck and token checks. Build runs in the publishing workflow.
- [x] Inspect desktop/mobile and independently review authorization/queue behavior.
- [ ] Package exact source and publish preserving Site audience; report unverified live-provider boundaries.

Implementation and local validation are complete. Publication is performed by the owning session after the checks above; see `docs/validation/2026-11-05-comment-prospecting.md` for verified behavior and remaining live-account checks.
