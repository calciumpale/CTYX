# Smart Schedule Implementation Plan

**Goal:** Add a real, persisted calendar for tasks, events and customer visits, with a compact AI planning assistant matching the supplied reference.

**Architecture:** A dedicated, member-scoped D1 store and `/api/schedules` endpoint preserve workspace isolation. A separate proposal-only model adapter validates drafts before the user saves them. A responsive React calendar owns date navigation and editing; the existing shell supplies navigation, identity and draft protection.

**Constraints:** Keep the current neutral Linear style and business permissions. Use Asia/Shanghai consistently, immutable append-only migrations, optimistic versions, idempotent creation, explicit AI preview, and no decoration with left-side colored bars. The user selected an independent 日程 sidebar entry after 项目跟进; desktop and mobile navigation share the same five business sections. No third-party invitation or calendar synchronization is implied.

- [x] Implement tested event validation, member-scoped CRUD, retry identity, version conflicts and an appended D1 migration.
- [x] Implement a configured-model proposal adapter with structured validation, known project IDs, time-conflict warnings and no write side effects.
- [x] Implement week/month/list views, three type filters, date navigation, unscheduled visits, project links and create/edit/complete/delete/restore flows.
- [x] Integrate the route and API permission registry, retain existing dirty/busy guards, update product/design documentation.
- [x] Verify with full regression/type checks, migrated local D1, representative desktop/mobile browser workflows, an independent review and production build.
**Release procedure:** Publish to the existing Site, preserve its audience and synchronize the private CTYX repository.

## Verification evidence

- Final full regression suite: 815 passed, 0 failed, 0 skipped, including browser fixtures. Typecheck and token checks passed (67 files, 0 errors).
- Appended Drizzle0012 applied successfully to the local D1 database; production migrations are handled by Sites publication.
- Real local UI verified linked timed visits, unscheduled visits, completion/reopen, all-day tasks, edit persistence after refresh, draft-leave protection, delete/undo and missing-model recovery. No paid model call or external invitation was sent.
- Tested 102 unscheduled visits through 100-item first page and final second page without missing/duplicating records. Large pagination fixtures were removed afterward.
- Week view shows seven days, month view42 cells for November2026, mobile defaults to list; desktop1440px and mobile390px have no document horizontal overflow.
- Independent review: SHIP after exact-ID reschedule recovery and independent unscheduled pagination were fixed and retested.
- Existing role boundaries remain enforced; manager team access is read-only for other members. AI generation uses injected model fixtures for deterministic validation.
