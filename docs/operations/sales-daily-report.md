# Sales daily report execution

## Scope and timing

The user confirmed **18:30 Asia/Shanghai every day**. The scheduled executor calls the existing published Site; it does not rebuild or republish it. Reports summarize that Shanghai date **through the generation time**, not a completed midnight-to-midnight day. The snapshot displays both business-event cutoff and current-pipeline snapshot time. The Site remains owner-private; existing API settings, audience and talk-track maintenance schedule remain.

There is one isolated workspace per authenticated platform account, with no organization-wide CRM. Reports aggregate only `dataOrigin: manual` projects in that account. The internal project owner labels are not proof of employee identities or access to other accounts. Sample or unmarked projects never contribute sales events or pipeline figures.

## Deployed updater contract

`POST /api/sales-reports/maintenance`

Use Sites-supported service access obtained from a **fresh `get_site` response**. Send its service token only to this Site in `OAI-Sites-Authorization`. Never save the token in source, a schedule prompt, docs or logs. **Unattended requests are cookie-free and contain no `oai-authenticated-user-*` headers**. The owner-private Sites gateway supplies the service authorization boundary; the application does not invent visitor identity. A signed-in visitor must use the manager experience and can update only their own workspace. Do not enable this endpoint on a public/shared Site without adding an independent service authorization boundary.

Initial body is `{}` with `Content-Type: application/json` (an empty body is also accepted). No date, user ID, project content, credentials or role override is accepted. Each request processes at most **five accounts**. For continuation send exactly `{"cursor":"<the returned nextCursor>"}`. Cursors are date-bound; begin again with `{}` after a Shanghai date change. The scheduler should continue while `hasMore` is true, with an explicit bounded batch budget; if it cannot finish, surface an actionable incomplete run instead of claiming all accounts were covered.

The JSON response contains only execution counters and a pagination cursor:

```json
{
  "date": "2026-10-24",
  "processed": 1,
  "generated": 1,
  "existing": 0,
  "waitingConfig": 0,
  "failed": 0,
  "hasMore": false,
  "readback": {
    "date": "2026-10-24",
    "verified": 1,
    "statuses": {"completed": 1, "running": 0, "waiting_config": 0, "failed": 0}
  }
}
```

`readback` is a **fresh D1 read after execution**, comparing persisted date record version, source hash and status. It never exposes customer content or account identifiers. Deployment validation must check the HTTP success, JSON date, `readback.verified === processed`, status counts and `hasMore`; `failed` or `waitingConfig` is not a completed model-generated summary. A repeated successful call normally returns `existing` and verifies the same saved record. An earlier manual preview is refreshed once when the daily execution reaches 18:30; repeated daily calls then reuse the saved date job.

Keep notifications quiet when nothing meaningful changes. Surface failed access, persistence/readback failures, incomplete pagination or configuration that requires user action. Do not report failure as successful generation or modify the separate talk-track schedule.

## Interactive API

The management view uses authenticated `GET /api/sales-reports?date=YYYY-MM-DD`, returning `{report,reports,coverageStart,today}`. `reports` contains the latest 30 date summaries and `report` is either the selected persisted report or null. No other account may be requested.

Authenticated same-origin `POST /api/sales-reports` accepts `{action,date?}` where action is `generate`, `retry`, or `regenerate`. `generate` reuses an existing date record. `retry` preserves the frozen input of a failed/config-waiting report; a completed report stays unchanged. `regenerate` explicitly captures the latest data and replaces that date's report under CAS. Future and invalid dates are rejected. Historical event totals remain real records, while a regenerated old date explicitly labels its pipeline as the current snapshot.

## Persistence and evidence

Migration `0004_reflective_lilandra.sql` adds isolated report, immutable sales event and coverage tables. Root integration calls `salesMutationEvents(before,after,action,payload,now)` before business persistence and passes the resulting events to `persistSalesWorkspace`. All other workspace writes pass no events. D1 `batch` atomically inserts source-ID/version-deduplicated events and performs workspace CAS; all statements share the exact original revision and JSON guard. A stale save creates no events, and an event failure rolls back the workspace update. There is no parsing of general activity prose and no backfilled synthetic history. Each account's explicit event coverage start is shown.

SQL counts all matching date/cutoff events; evidence queries are capped at 100 rows and report evidence at 20 actual events. Current priority projects are capped at 12, owner summaries at 100, and history at 30. Model messages are measured and trimmed to **24,000 UTF-8 bytes**. Numeric KPIs come from code; the optional model writes a brief narrative with validated allowed evidence IDs and no new numeric claims. Stored SHA-256 source hashes identify the frozen report input. A ten-minute lease and report version CAS prevent competing or expired workers from overwriting a newer result.

Without enabled model configuration, nonempty days retain complete factual statistics in `waiting_config` and offer a retry. Model/provider/validation failure retains the factual snapshot as `failed`; no synthetic model success is recorded. An empty-event day is a valid completed `facts` report without a model call. Pipeline amounts mean user-recorded opportunity amounts, not signed revenue or money received. Current A-tier counts include only assessments still bound to the latest project version/hash; unknown/stale assessments are not promoted to A.
