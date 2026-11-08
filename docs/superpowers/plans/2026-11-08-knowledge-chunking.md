# Configurable Knowledge Chunking and Batch Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add character-based configurable chunking, safe reruns, batch/drag import and consistent control heights to the existing knowledge workspace.

**Architecture:** Keep current active chunk/search contracts. Normalize app-owned parameters, persist exact source pages, stage rebuilt chunks/vectors and activate them under owner/revision/job guards. Browser queue handles local parsing and per-file outcomes; global navigation protects in-progress work.

**Tech Stack:** TypeScript/React/Vinext, D1/Drizzle, existing document parsers/Embedding adapter, Node SQLite, isolated Chromium.

**Spec:** docs/superpowers/specs/2026-11-08-knowledge-chunking-design.md. Direct user requirements and confirmed character unit; implementation boundaries are documented choices.

## Global Constraints

- Preserve the five accounts, projects, assistant/task journal, Site audience/env, private GitHub and v1.2.1. No live customer test messages, paid Embedding/media QA or automatic production re-chunk.
- Characters128–6000; overlap0–30%; lines1–200; literal delimiters<=8x40; parent<=6000 and child<=parent. Existing source1000000/file10MB/total6000chunks/aggregate3000000 chunk chars limits remain.
- Library defaults affect future imports only; document applied configuration is a snapshot. Legacy source absence is explicit and requires original attachment, never invented reconstruction.
- D1 bounded source/JSON pages, <2MB bindings and<=100 params; no runtime DDL. Owner/trusted role/origin/body checks remain on every request.
- New chunks/FTS/vectors activate together after success. Failure/cancel/stale work leaves old usable content. Never publish mixed generations or resurrect deleted records.
- New file batch<=20, concurrency<=2, stable request identity and truthful independent progress/retry; keep paste import.
- Shared36/44px outer control heights, neutral design and no decorative left bars.

## Review Focus

1. An accepted upload response is lost; retry must return its original document without duplicate count or changing effective parameters.
2. Index provider accepts a slow batch while a task is canceled/replaced/document deleted/model changed; old response must not overwrite or revive new active data.
3. Re-chunk or FTS/source commit fails midway; exact original plus old retrieval remain usable, including parent-child and existing ready vectors.
4. A large CJK/emoji/Excel multi-sheet source and tiny/overlapping settings must stay bounded without truncating tail, breaking locators or exceeding D1 bindings.
5. Dragging invalid and valid files together, switching libraries/accounts/pages or stopping a batch must not lose unrelated work or silently retarget files.

### Task 1: Config and splitting algorithm

**Files:** new app/lib/knowledge-chunking-config.ts; app/lib/knowledge-library-chunks.ts; tests/knowledge-library-chunks.test.ts plus focused config tests if useful.

**Interfaces:** exact KnowledgeChunkConfig/defaults/normalizer/description and splitConfiguredKnowledgeText in spec. Preserve legacy splitKnowledgeText(text,strategy), tokenizeKnowledge and output topology.

- [ ] Write RED cases for every new strategy, configured overlap, invalid parameters, Unicode, heading/fence handling, parent-child and capacity/tail.
- [ ] Implement strict app-owned normalization and deterministic bounded splitting; no user regex or token-accuracy claim.
- [ ] Run new/legacy chunk tests and Excel parser integration, tsc/scoped lint as available; report contracts and actual evidence. No shared type/schema/UI/index edits.

### Task 2: Source/settings, idempotent upload and safe re-chunk backend

**Files:** knowledge-library-types/store, new knowledge-library-rechunk helper if needed, route, db/schema.ts+0023 migration/snapshot/journal, focused realSQLite tests/capacity/member-policy coverage. Only backend worker writes schema/migrations/types/route/store.

**Interfaces:** API actions/public optional fields exactly in spec. Consume Task1 normalized config/splitter. Existing search output/agent library allowlist remain unchanged.

- [ ] RED realSQLite tests for source/default roundtrip, legacy source absence, invalid/foreign/role requests, upload identity conflicts/retries and preview no mutation.
- [ ] Persist exact UTF-8 source pages, applied settings and versions; resolve defaults server-side; add additive schema-only migration after0022.
- [ ] RED staging/failure/race tests: ready old data while rebuilding, failed vectors keep old results, stale jobs/index/delete/cancel/model change, final statement injected failure and idempotent completion.
- [ ] Implement bounded staged chunks/vector batches and guarded atomic activation/cleanup; retain parent references, FTS and source hashes. No provisional active mutation.
- [ ] Exercise million-CJK bounded bindings/params, Excel row/second-sheet queries and old fixtures. Run focused tests/tsc/scoped lint; document exact methods and field/response shapes. No commit/deploy/live data operation.

### Task 3: Parameter UI, preview/re-chunk and batch/drag importer

**Files:** KnowledgeLibraries.tsx/.css; new reusable chunk controls/import helpers as appropriate; knowledge UI and batch tests. Root owns Workbench.tsx/AdminWorkspace.tsx integration, package/docs.

**Interfaces:** consume Task1 config and Task2 API. KnowledgeLibraries gains onBusyChange?, onDirtyChange?; clean up callbacks on unmount. Keep notify and read-only sales path.

- [ ] RED actual-component browser cases for settings, preview/apply, old-source attachment and failed/resumable job state; old chunks not replaced optimistically.
- [ ] Build visible library defaults and document effective/proposed parameters with one reusable controls component and same36/44px geometry.
- [ ] RED multiple-file picker + drag/drop, mixed failure/success, stable retry request, indexing-only retry, stop/continue and draft guard cases.
- [ ] Implement bounded2-worker queue with captured library/config, per-file outcomes, parser warnings and no duplicate documents after ambiguous response. New queue does not erase paste input or unrelated rows.
- [ ] Browser desktop/mobile and short layout in one batch, at most one correction batch. Scoped lint/typecheck and relevant functional tests; report actual checks. No live writes/paid calls/commit/deploy.

### Task 4: Root integration, independent review and publication

**Files:** Workbench.tsx, AdminWorkspace.tsx, package.json, PRODUCT.md/DESIGN.md, focused navigation integration tests. Existing height audit added tests/form-controls-ui.test.mjs and found current shared CSS already correct in15 module×viewport combinations; preserve it.

- [ ] Wire busy/dirty to global and internal knowledge navigation/logout, preserving existing unrelated guards and prompt focus.
- [ ] Register all new test files; update actual capability docs and direct official reference notes.
- [ ] Independent task reviews and one most-capable whole-branch review, bounded fix waves and scoped closure. No redundant reviewer seats.
- [ ] Final frozen full browser suite with file concurrency4, typecheck/lint/tokens/diff and production build. Do not overlap heavy browser full suite with lint/build.
- [ ] Commit/push private GitHub main and package matching exact source tree for existing private Site; preserve audience/env/v1.2.1. No production document re-chunk/import for QA.
- [ ] Verify native additive tables and admin UI settings/batch/drop controls/missing-source state read-only; restore browser to useful user work surface. Report actual live version, capabilities, source-missing boundary and verification limits.


### Task 5: Department knowledge before every automatic reply

- [x] Resolve persisted conversation member to trusted enabled account department; compulsory shared+own library retrieval regardless optional policy selection.
- [x] Filter legacy Skills/knowledge and lexical/semantic published talktracks by explicit department or trusted author ownership; initial unowned material stays shared.
- [x] Preflight greeting, image, contact, memory, direct and generated reply branches; retrieval failure yields no automatic queued message. Persist bounded lookup audit.
- [x] Focused tests and independent scoped review PASS. Final branch QA remains in Task4.

### Task 6: Conversation case to reviewed talktrack Skill

- [ ] Implement deliberate conversation extraction, durable idempotent source capture/job and manager review, with real task-bound evidence and original department attribution; follow the conversation contract in the public design spec.
- [ ] Candidate/rejected excluded; reviewed templates become department-scoped retrievable talktrack knowledge; preserve initial shared content and won-project pipeline.
- [ ] Focused ownership/redaction/replay/version/review/UI tests, independent scoped review, then Task4 frozen verification.

### Task 7: APImart existing result delivery

- [x] Diagnose persisted saving95% image task without paid resubmission; add sanitized precise stage metadata.
- [x] Bounded auto status queries, explicit same-task save retry, private image/video elements, bounded R2 multipart for unknown-length results.
- [x] Focused service/storage/component tests and scoped review PASS, including root clock-driven query/stop/recover/unmount and secret-safe error cases.
- [ ] After authorized deployment, refresh the original existing task, diagnose actual host/MIME/download/storage issue, correct demonstrated incompatibility safely and recover its result. Do not submit new paid image/video generation; report actual recovery and video QA limits.
