# Sales Intelligence Implementation Plan

> **For agentic workers:** Execute bounded independent tasks in shared checkout with disjoint files; root owns integration and Sites publication.

**Goal:** Ship voice/text intake, grounded ABC assessment, dynamic forecast and an unattended daily sales report.
**Architecture:** Existing model configuration and versioned workspace, structured evidence-validated model outputs; standalone daily event/report tables and idempotent scheduled service.
**Stack:** React, TypeScript, Vinext, D1, existing browser speech adapter, Sites cloud schedule.
**Spec:** `docs/superpowers/specs/2026-10-24-sales-intelligence-design.md`

## Constraints
- Existing audience, API credentials and talktrack schedule remain.
- No invented facts, demo health-to-probability relabel, cross-account aggregation or decorative left bars.
- Persist user records before fallible model analysis; require fresh fingerprint before writing assessment.

## Review Focus
- Sparse notes, explicit rejection, missing budget and contradictory followups yield bounded evidence-based outputs.
- Concurrent edits and failed providers never lose saved records or mark old forecasts current.
- Replayed utterance/request cannot duplicate a project; ambiguous enterprise or multiple enterprises requires clarification.
- Daily timezone/date isolation, duplicate jobs, no-new-events days and absent model remain truthful.
- Voice unsupported/denied and mobile forms provide usable recovery.

## Tasks
- [ ] Intake: tests first; structured extraction, exact evidence validation, speech/text composer and idempotent domain hook contract.
- [ ] Intelligence: tests first; evidence/rubric/forecast/freshness engine and save-first processing service adapter; root integrates actions/model context and UI.
- [ ] Daily reports: tests first; schema/migration, event log, deterministic aggregation, guarded model narrative, job/lease, list/detail/API and view.
- [ ] Integrate: mutation hooks, board/detail labels and suggestions, nav/guards, daily scope/config; full checks and independent review.
- [ ] Verify/publish: local synthetic end-to-end and desktop/mobile; source helper build/private deploy; unattended write/readback; create one linked daily schedule, report saved timing.
