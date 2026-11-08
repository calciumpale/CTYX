# Task-scoped conversation memory validation

Date: 2026-11-08. Runtime baseline: `6be27d1`.

## Behavior

- Stable physical conversation IDs; task-scoped facts, message sources and contact associations. One active task per physical thread.
- Sourced need corrections, additional conditions, unresolved questions and verified human confirmations. Human correction, retraction and ignore actions invalidate stale generation.
- Reliable memory ingestion continues during human takeover. Task switching retains human takeover, opt-out and unknown-send controls.
- Contact invitations count only after verified submission. Contextual contact refusal persists across later turns. Submission does not imply delivery or read receipt.
- A shared knowledge agent handles direct-answer versus retrieval decisions for the reply robot, normal workbench agents and workflows. Business facts require authorized evidence; at most one bounded retrieval precedes the final answer.
- Fixed desktop prospecting navigation and main workspace with internal scrolling; short-height and mobile input remain reachable.

## Verification

- `PROSPECT_BROWSER_TEST=1 npm test`: 1230 passed, 0 failed, 0 skipped. Includes isolated browsers, actual SQLite migrations and concurrent invalidation cases.
- After the final test declaration lint correction: memory integration 9/9 and typecheck passed.
- Full lint: 0 errors, 4 existing unused-variable warnings. Token check: 75 files, 0 errors. `git diff --check` passed.
- Independent task and whole-branch reviews passed. Final regressions cover semantic pending-source retention, exact task contact links, contextual refusal persistence and queued-to-submitted human confirmation.
- Browser checks use isolated fixtures and mocked APIs. No test messages were sent to real customers.

## Data and runtime limits

Migrations 0016-0018 are additive. Existing conversation/job identities, send history, local journal, legacy refusal suppression and conservative invitation budgets remain intact. Sites applies migrations before updating the Worker.

Reliable historical backfill is bounded to 40 new sources per absorption batch. Unreliably attributed history stays outside model context. Semantic failure preserves pending sources and blocks stale automatic generation until retry. Recall is bounded and task-scoped; unlimited historical context or unbounded snapshot/event scale has not been validated.

Before reverting to a binary without task-attribution support, stop automatic reception/replies. Keep additive data and the bridge journal; do not clear invitation budgets.
