# Douyin verification wait implementation plan

> **For agentic workers:** Use test-first implementation and independent review for each bounded task.

**Goal:** Temporary pre-dispatch identity verification pauses one approved reply, rather than producing failed chat bubbles and repeated model decisions.

**Architecture:** Keep one logical reply ID and one message row; use a separate job ID for each bounded execution attempt. Preserve native journal checkpoints and all identity, recipient, snapshot, policy, tenant and opt-out guards. Wait for transient owner-page hydration in the same document, without extra navigation.

**Tech Stack:** TypeScript, React, D1-compatible SQL, native Node bridge, Playwright isolation tests.

**Spec:** The user's request to fix repeated send failures, read-only production journal evidence, and the existing auto-reply validation record.

## Global constraints

- No retry after dispatch, submission or an unknown result.
- No repeated model or memory updates for one verification wait.
- Automatic retries are bounded; existing account and navigation cooldowns remain.
- Keep old attempt audit records and distinguish real failures from known unsent verification waits.
- Preserve the existing Site audience, credentials, user data, native profile and private GitHub repository.

## Review focus

- A late completion from an old attempt cannot alter the current message or lease.
- A changed snapshot, new inbound, manual takeover, policy change, pause or opt-out cancels stale approved replies.
- Browser hydration duplicates or replaces owner controls temporarily, but never proves a different identity.
- Legacy wait records stay inspectable without masquerading as customer-visible sent messages.
- Repeated waits cannot consume all reply quota or cause an unbounded refresh loop.

## Tasks

1. Backend: reproduce one inbound causing several failed messages; add failing durable-retry and race regressions; retain a stable reply ID and memory while fencing bounded new attempts.
2. Adapter: reproduce temporary duplicate owner labels and replaced controls; wait under one bounded same-document deadline, preserving hard identity and safety guards.
3. UI: add an explicit waiting status, group known unsent legacy verification records, and keep true failures and unknown results visible; test state transitions, drafts, IME and scrolling.
4. Diagnostics: pass only fixed cause enums for verification pauses; test that arbitrary text cannot enter private diagnostics.
5. Run targeted and full browser tests, type and token checks, independent review and production packaging. Publish the selected Site, update the native helper safely and verify the existing real conversation.
