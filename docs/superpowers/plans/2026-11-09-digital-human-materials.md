# AI营销素材与数字人 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Checkboxes track bounded deliverables.

**Goal:** Restructure marketing media and integrate honest ZEGO source/avatar/live workflows for user-provided third-party push addresses.

**Architecture:** Keep APIMart image/video workflows separate from member-private ZEGO uploaded assets and live sessions. ZEGO customization follows its actual enabled platform/service; official REST verifies models and manages CDN broadcast instances. Reuse existing encrypted settings, D1 CAS identities and private R2 streaming.

**Tech Stack:** Existing React/Vinext/Cloudflare Workers, D1, R2, Node crypto, node:test+real SQLite, installed Playwright. No added dependency.

**Spec:** `docs/superpowers/specs/2026-11-09-digital-human-materials-design.md`

## Global constraints

- Existing materials route, owner-only Site, GitHub privacy, account/session and department scopes remain.
- Credentials and complete push URLs stay encrypted server-side; no fabricated training API/progress/stream success.
- Controls36px desktop/44px mobile; no decorative left accent bars.
- No paid generation/training/live start or real source upload during QA; use deterministic fixtures.

## Review focus

1. Response loss after source upload/live creation/TTS must preserve identity and never duplicate paid calls.
2. Old upload leases/results must not overwrite a newer claim; bounded video memory and cleanup.
3. Source, avatar and live access must be pinned to owner+member, including IDs supplied by another department.
4. Platform-only customization and ZEGO instance acceptance must not be represented as training completed or target platform live confirmed.
5. Top-tab switching/unmount must retain drafts/guards and avoid starting/stopping live sessions.

### Task 1: Materials navigation and image/video surface

Owner: materials_navigation_rework. Files: MarketingMaterials.tsx, marketing-materials.css, workspace-navigation.ts, MaterialConnectionSettings copy, existing material/navigation/browser tests.

- [ ] Verify RED for new title/two tabs/noPPT.
- [ ] Implement two-tab shell and image/video modes, preserve original-task polling/recovery/idempotency/drafts.
- [ ] Pass real component desktop/mobile/guard/lifecycle tests; root integrates actual DigitalHumanWorkspace contract.

### Task 2: ZEGO provider, private assets, encrypted configuration and live services

Owner: digital_human_architecture_audit follow-up. New digital-human-types/provider/store/service/runtime modules, /api/digital-humans + source route and /api/zego-connection, schema+next migration, own focused tests.

- [ ] Read spec contracts and official research; create real SQLite/provider/storage failing tests.
- [ ] Implement exact signing/fixed hosts/readonly connection test; encrypted config and member isolation.
- [ ] Implement durable raw streaming asset upload with validation/fencing and private range reads.
- [ ] Implement actual avatar-info verification and honest customization flow, never a made-up train action.
- [ ] Implement encrypted live configuration, explicit start/speak/query/stop with request identity/CAS and ambiguous outcomes.
- [ ] Pass focused tests/typecheck/scoped lint; no staging/committing or full build.

### Task 3: Digital-human interface, admin settings and policy integration

Owner: root. New DigitalHumanWorkspace.tsx, digital-human-workspace.css, ZegoConnectionSettings.tsx; StudioViews.tsx, member-policy.ts, package test registration and product/design docs.

- [ ] Implement actual source reservation/upload/drop/retry and clear waiting-for-customization/verified-ready states.
- [ ] Implement existing model association and per-asset live config/start/speak/stop forms with secret-safe reloads.
- [ ] Admin settings use exact backend contract, blank-preserve credentials and readonly test.
- [ ] Policy tests pin explicit new methods/roles; real component tests cover no implicit external actions/draft retention/errors/mobile fit.

### Task 4: Integration, review and release

- [ ] One consolidated contract/requirements review; fix demonstrated issues in a coordinated wave.
- [ ] Freeze final source and run full suite once, typecheck/tokens/lint/build; repeat only affected checks after fixes.
- [ ] Commit and sync private GitHub; package matching Site source tree; publish to same owner-only Site.
- [ ] Read-only production check new UI/unconfigured states, existing recovered APIMart result and schema. No paid broadcast/testing with real push URLs.
- [ ] Deliver current version/features plus precise ZEGO service/credential/customization prerequisites and real-live QA limit.
