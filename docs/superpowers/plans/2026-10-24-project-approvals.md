# Project Approvals Implementation Plan

> **For agentic workers:** Use bounded parallel implementation with disjoint files; root integrates and verifies. Source helper owns commit/push.

**Goal:** Implement project business-condition and contract approvals through real, sequential finance/legal approvers.

**Architecture:** Separate D1 requests and templates, gateway identity authorization, immutable submission snapshots, CAS transitions. Existing project workspaces stay isolated.

**Tech Stack:** React, TypeScript, Vinext, Cloudflare D1, existing CDS tokens.

**Spec:** `docs/superpowers/specs/2026-10-24-project-approvals-design.md`

## Global Constraints
- Retain audience, runtime credentials and existing schedules.
- No decorative left accent bars; use established CDS tokens.
- No role-cookie authorization, automatic AI approval, cross-workspace access, or silent stale-contract approval.

## Review Focus
- Wrong account/email must not read or decide an approval.
- Concurrent and duplicate decisions must not advance twice.
- Contract changes must invalidate prior approval without invalidating on finding-status-only changes.
- Missing templates, empty inbox and network errors need clear actionable UI.
- Returning from detail and leaving an unsent application must preserve user intent.

## Tasks
- [x] Domain: first write failing tests; implement types, immutable request creation, route validation, sequential transitions, snapshot hash, summary projection; run focused tests.
- [x] Storage/API: first write failing SQLite adapter tests; add D1 schema/migration and store, verified identity API and workspace source checks; run focused tests.
- [x] UI: build forms, route templates, inbox/detail/history, state/error/unsent protection in existing visual world; root wires nav/project/contract entry.
- [x] Integrate: full suite/typecheck/tokens; independent security review; bounded desktop/mobile interaction QA.
- [ ] Package: Sites helper builds and pushes, then private deploy; verify native deployment status and report actual limits.

Validation: 313 tests pass; TypeScript, CDS token check, targeted ESLint and whitespace checks pass. Browser QA used synthetic local records to verify submit, finance advance to legal, mandatory return/reject note, withdraw/resubmit linkage, project status, templates, saved-contract entry, source-change supersede, deep links and dirty leave guard. Desktop1280 light and mobile390 dark show no horizontal overflow. Independent review found three P2 issues; all corrected and reverified. Publication pending below.
