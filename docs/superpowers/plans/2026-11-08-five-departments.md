# Five-department AI Marketing Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver five isolated sales portfolios, 250 sourced public organizations, marketing material generation, public keyword lead collection, a repaired Douyin reply path and the AI营销工作台 name.

**Architecture:** Extend the existing React/Vinext application, D1 and private R2. Retain physical conversation/member identities and owner-scoped connections; add trusted sales scope, a guarded setup ledger, account-scoped material/search tasks and authenticated result routes. APIMart integration is implemented now; user supplies the key later.

**Tech Stack:** TypeScript/React, D1/Drizzle, R2, WebCrypto, existing text model, APIMart HTTP APIs, Bing RSS, fflate OOXML PPTX export, Node SQLite tests and isolated Chromium.

**Spec:** docs/superpowers/specs/2026-11-08-five-departments-design.md. User approved "按说明全部执行" on 2026-11-08. Existing isolated host worktree is retained. Proactive parallel delegation is authorized; no further execution-method approval is needed.

## Global Constraints

- Accounts YL/CH/ZS/YY/WL, password admin once; keep legacy sales account_id and sales-1 as ZS. Every sales boundary uses authenticated salesId; never trust editable payload/state identity.
- Preserve stop controls, task memory, bridge journal, unknown/running outbound reservations and owner isolation. No real-customer test messages or newly initiated contact jobs for QA.
- Replace active old company directory with recoverable history and primary-sourced public prospects. Research is not customer testimony, engagement, forecast, contact capture or revenue.
- APIMart key is deferred. No paid generation in this delivery. Persist before submitting; ambiguous submission cannot be auto-retried. Preview/download require account authorization and private persistence.
- Use existing neutral design, 36/44px controls and internal scrolling. No decorative left accent bars.
- Additive migrations only. Keep existing Site access/environment and v1.2.1. Publish reviewed code to private GitHub main and existing Site.

## Review Focus

1. A second sales principal cannot access another principal's project through chat, contracts, approvals, voice/media, stale session or direct-ID API.
2. Concurrent workspace write or repeated setup cannot half-create accounts, re-reset passwords, erase later work, replay customer outreach or lose old approval aliases.
3. A provider may accept a paid task before a network timeout; refresh, duplicate clicks and stale poll responses must not create another submission or lose terminal results.
4. Search snippets are untrusted; off-platform results, ambiguous regions, response failure and old public registries must never become verified current customer intent.
5. Image messages, current-task freshness and media/data archives retain their semantics across migration, UI navigation and the live assistant update.

---

### Task 1: Repair typed image synchronization and resume

**Files:** prospecting chat/memory modules/types, bridge core/transcript, db/schema.ts content_type, migration 0019 and related tests. Owner: reply_recovery_1108; separate review: five_dept_builder_review.

**Interfaces:** Optional message `contentType:'image'`, exact placeholder `[图片消息，内容未识别]`; no image URL/pixel inference. The bridge retains known-author single-image rows in ordered snapshots; latest image gets a deterministic clarification with no model, evidence IDs or answered-question IDs. Memory consumes source position without extracting facts. Resume fallback requires a current-task, current-period proven anchor, excluding eligible=0 historic baseline.

- [ ] Reproduce image→text recovery, latest image, unknown/mixed/status/coverage guards and resume historic-anchor bug before fixes.
- [ ] Apply typed persistence/transport and source guards; preserve prior unanswered business questions and invitation budget.
- [ ] Run full browser-enabled suite, typecheck and owned lint; independent narrow review closes findings.
- [ ] Root builds/publishes this bounded repair, gracefully updates the installed assistant and observes normal reliable polling/processing without test sends.

### Task 2: Authenticated sales scope, five accounts and sourced-company setup

**Files:** member-auth/policy, domain/contract/talktrack guards, server and existing workbench/approval/media/voice routes, types/seed, new `workspace-departments.ts`, `workspace-departments-store.ts`, `workspace-setup-service.ts`, `app/api/workspace-setup/route.ts`, new 0020 migration/metadata, new focused tests. Root integrates required minimal company/archive UI after API contract. Owner: accounts_migration_design_1108.

**Interfaces:** Trusted per-request scope `{salesId:string,displayName:string,accountId?:string}` is optional only for old pure-unit compatibility; production sales routes fail closed without it. Add `Deal.dataOrigin:'research'` and optional archival metadata. Project projections filter active directory while explicit archived history remains readable by the same authorized principal. `DepartmentResearchRow` uses `externalKey,ownerUsername,legalName,industryKey,region,sources,facts`; `previewDepartmentSetup(db,ownerId,dataset)` returns expected revision/hash, account conflicts, before/after counts, size and manifest hash; `applyDepartmentSetup(...,expectedManifest)` applies atomically and returns stable result.

**Data:** Root supplies committed normalized `data/prospect-companies/2026-11-08.json`; current raw research is /tmp/ctyx-research-1108/{landscaping,surveying,restaurants,hospitals,travel}.json, with records/rows normalized by root. Source dates and current-license-not-checked status stay visible. Each category50, primary sources, no personal contacts.

**Deployment operation:** Expose only fixed preview/apply for this vetted dataset. Existing authenticated admin UI can call it. Root may also use a short-lived, purpose-bound HMAC capability signed with server CONFIG_ENCRYPTION_KEY through private Sites service access, so no browser password entry or raw database-write endpoint is needed. Capability canonical payload binds `version:1,purpose:'department-setup',ownerId,action,datasetId,expiresAt,nonce` and, for apply, expected revision/state hash/manifest hash. Verify WebCrypto HMAC SHA-256, max10minute lifetime, allowed action/dataset and exact body fields. No unsigned arbitrary owner selection, SQL, arbitrary dataset URL or general member mutation. Completed ledger makes replay idempotent; changed payload/conflict fails. Credentials/signatures never enter logs or files. Route service exemption is narrow; admin access still requires normal auth. The legacy account and every account/ledger/backup/workspace mutation share the full expected-state guard.

- [ ] Add real-SQLite failures for two sales read/write/model/media isolation, empty portfolio, current manager assignment roster, disabled member and missing salesId.
- [ ] Parameterize all hardcoded sales-1 checks including contracts, approval project access, recordings, speech, training, query mention matching, workflow/history and intake duplicate matching. Retain actual member salesId in generated context without persisting caller identity as authority.
- [ ] Rename existing sales→zs, retain IDs/references, create four new accounts with unique sales IDs and salted PBKDF2 admin password; bootstrap new owners into seven members without resurrecting old sales. Preserve approval stable alias through rename.
- [ ] Add one-time backup/ledger and conflict manifest; every statement uses workspace+account expected-state guard. CAS failure leaves no account/password/ledger/portfolio side effects. Reapply returns existing result without revision/credential/session changes.
- [ ] Archive old companies with references/history; remove only pristine unreferenced examples. Preserve all old sales business for ZS and all task/journal/KB data. Reject unsafe capacity above1.8MB before write.
- [ ] Import250 research rows with deterministic IDs/dedupe and empty customer facts/activity/amount. Mark research explicitly and exclude imports from true sales-event counts and model testimony.
- [ ] Verify source allocation, provenance, archive/history, race rollback, other-owner preservation and HMAC expiry/tampering/replay/owner/dataset restrictions; run focused tests/typecheck. Hand off public interfaces and touched files; no commit/deploy/live setup.

### Task 3: Marketing material service and UI

**Files:** New `marketing-material-types.ts`, `marketing-material.ts`, `marketing-material-store.ts`, `marketing-material-service.ts`, `marketing-material-runtime.ts`, `marketing-pptx.ts`; new `/api/marketing-materials` + `/api/marketing-materials/result` + `/api/material-connection` routes; new `MarketingMaterials.tsx`, `MaterialConnectionSettings.tsx`, CSS/tests. Additive0021 schema/migration coordinated with root after0020. Owner: delegated worker; root owns Workbench/navigation/shared entry integration.

**Interfaces:** `MaterialKind='presentation'|'image'|'video'`; persisted task carries ownerId/memberId, requestId/payloadHash, version, status `submitting|submission_unknown|queued|processing|saving|completed|failed|expired`, providerTaskId?, sanitized error/progress, private R2 object keys and slide draft. `GET /api/marketing-materials` returns only current member tasks and public availability; POST actions `generate|refresh|updateSlides` use origin/body/owner/member checks and versions. Result route authorizes owner/member+taskId+fileIndex and streams private objects with safe attachment names. Connection GET/POST is admin-only, versioned, encrypts APIMart key with existing primitives and never returns it; connection test uses non-generating model metadata.

**Provider contract:** Fixed `https://api.apimart.ai/v1/images/generations` default `gpt-image-1-official`, image size1:1/2:3/3:2, n1(default)–4. Fixed videos endpoint default `kling-v3`, mode std, duration5(default),3–15seconds, aspect_ratio16:9/9:16/1:1, audiofalse. Official docs verified2026-11-08: GPT image generation, Klingv3 generation and tasks/status. POST returns `{code:200,data:[{status:'submitted',task_id}]}`; GET `/v1/tasks/{id}?language=zh` returns data.status/progress/result.images or videos, with URL array. Do not silently accept arbitrary model parameter sets. Config can select supported image models1/1.5; video Klingv3.

**PPT:** Existing text model generates a validated JSON slide deck from deliberate product/target/selling-points/reference input only; 5–12slides, plain text, no invented evidence. Client edits titles/bullets and exports .pptx with fflate minimal OPC/OOXML; no Node-only dependency in Worker/client. HTML slide preview uses same bounded layout/content. Validate output by ZIP/XML relationships and an independent reader, and export an inspection artifact.

- [ ] Red tests: missing key/model, cross-account task/file, duplicate/same-key payload conflict, timeout after upstream accept, concurrent refresh, stale terminal overwrite, upstream500/redacted errors, oversized or forbidden result URL.
- [ ] Implement encrypted APIMart config and durable pre-submit CAS. Exactly one providerPOST per request identity. Unknown submission stays visibly unresolved; refresh never creates a new task. Poll at most once per task per5seconds, bounded network/body size, no endless loops.
- [ ] Validate provider result destinations as public HTTPS on explicit trusted provider host(s), reject IP/credentials/redirects; fetch with no forwarded secret/cookie, bounded file bytes. Persist R2 privately before task completed. Retry saving via same providerTaskId without paid resubmit; expired links are explicit.
- [ ] Implement bounded structured PPT generation, editable preview, real PPTX export and task history. No unsupported factual claims from model drafts.
- [ ] UI tabs, prompt/input retention, disabled/busy/empty/error states, keyboard/IME, short/mobile layouts and account-isolated history. Admin connection included in service settings by root.
- [ ] Run functional/service/provider tests, PPTX structural/reader validation, isolated component browser tests, typecheck/lint/token checks. No paid calls, no commit/deploy, report actual validation and deferred-key boundary.

### Task 4: Bounded public-web lead collection

**Files:** New `web-prospect-types.ts`, `web-prospect-search.ts`, `web-prospect-store.ts`, `web-prospect-service.ts`, `web-prospect-runtime.ts`; new `/api/web-prospects` route; new `WebProspecting.tsx` and CSS; tests; additive0022 migration coordinated after0021. Owner root initially; may delegate bounded units when slot frees.

**Interfaces:** Platform `all|tieba|xiaohongshu|zhihu|weibo|other`; server-known host registry (`tieba.baidu.com`, `xiaohongshu.com`/`xhslink.com`, etc.). Search input keywords<=5x40chars, region<=60chars, Tieba requires region; query providers are fixed Bing RSS origins, no caller URL or site operators. A task has member scope, requestId/hash, status `running|completed|partial|failed`, bounded source errors and<=50 leads. Lead stores canonical sourceURL/title/excerpt/platform/query/region evidence and `regionMatch:'confirmed'|'unverified'`, dates and review status. No reply job/lead-capture invitation path.

- [ ] Red tests: malformed/search-operator input, missing Tieba region, off-platform URL, ambiguous region, untrusted/injected snippet, duplicate URLs, provider failure vs real empty result, two-member isolation, concurrent/rate-limited create, explicit conversion authorization.
- [ ] Fixed-host bounded RSS search (8s/query, sequential/bounded total budget, response<=256KB, source<=50, no arbitrary crawling). Filter normalized hosts after query; region confirmation requires excerpt/title evidence.
- [ ] D1 member-scoped task/results/review operations, 1running/member, 30sec create interval, idempotent request key/hash and stable URL dedupe. Persist partial/failure state and bounded errors; old polling cannot overwrite newer review.
- [ ] UI mode inside existing prospecting navigation, keyword/region/platform controls, internal scrolling list/detail, source-open, effective/ignore filters and explicit reviewed-lead→new-project action via authenticated sales scope. No auto-contacting or pretending search results are known buying intent.
- [ ] Unit/realSQLite/service/isolated-browser checks and actual non-contact public query probe, distinct empty/failure accounting, typecheck/lint/token.

### Task 5: Shared navigation, name, archival UI and documentation

**Files:** Workbench.tsx, workspace-navigation.ts, types.ts View only (coordinate account owner), globals/necessary layout selectors, CoreViews/WorkspaceLogin/layout/PRODUCT/DESIGN and affected branding docs/tests. Root owns these shared UI files.

- [ ] Add `materials` view/navigation immediately after prospecting for sales/manager and wire Task3 component; admin only sees connection config in existing service settings. Update route/permissions direct addresses and mobile names.
- [ ] Add explicit social/fullweb mode to prospecting area with draft/dirty guards; preserve existing create/screen/handoff query routing and fixed shell.
- [ ] Replace product-facing 营销工作台 with exactly AI营销工作台 in login/loading/nav/metadata/embed and hosted Site metadata; do not rename storage IDs, cookies, app bundle or journals.
- [ ] Add archive/history access without listing old companies in active directory; show research facts/source dates/status independently from real customer notes. Coordinate Task2 interfaces.
- [ ] Update PRODUCT/DESIGN/API docs to actual completed capabilities and name; run real desktop/mobile inspection in one batch, then at most one correction batch and final detector.

### Task 6: Integration and publication

- [ ] Explicitly include all new tests in package.json; run browser-enabledfullsuite/typecheck/lint/token/diff and productionbuild on final source, inspect exitstatus and counts.
- [ ] Independent most-capable whole-branch review covers identity, setup atomicity, materialpaid-submit state, private assets, searchgrounding, botregression and archives. Fix concrete important issues and narrow re-review.
- [ ] Package same Git source tree, compare tree hashes, push private GitHubmain and existingSite; preserve audience/environment/v1.2.1. Deploy only saved matching archive/version.
- [ ] Apply fixed preview/setup capability for intended owner only, validate concrete manifest/250allocation/backup before mutation; user already authorized all migration/deletion scope. Verify five logins/isolation via API, source counts, originalmember/device/task continuity; no extra user permission.
- [ ] Verify additive schema, actualexistingassistant status/normalobservations and noWorkererrors; update installedassistant if notalreadycurrent. No synthetic customer-outbound tests.
- [ ] Report final liveversion/URL, fiveaccountcredentials, eachimportcount and source-date scope, materialentry and APImartpendingkey, fullwebcollectionlimits and exact remaining verification gaps.
