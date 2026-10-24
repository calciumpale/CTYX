# Sales intake, intelligence and daily report validation

Implemented sentence/paragraph and recognition-final customer intake, project-level A/B/C intent scoring, dynamic win estimates, and manager daily reports at the user-confirmed 18:30 Asia/Shanghai.

## Source and behavior checks

- The full Node suite passed 396 tests before publication packaging; packaging repeats it against the exact source being pushed.
- Global TypeScript, focused ESLint, CDS token checks and diff whitespace checks passed.
- One static Impeccable pass across the three new surfaces returned no findings; screenshots were independently reviewed on desktop/light and mobile/dark. No decorative left accent bars were added.
- Local migration 0004 executed successfully. Existing earlier migrations remain unchanged.

## Real local integration

The browser and HTTP checks ran through the real local app and D1 using a temporary loopback model adapter with clearly synthetic data. They validate application wiring, persistence and error handling, not production model quality or calibrated forecasting accuracy.

- A single paragraph created a manual project, preserved the original statement, populated explicitly supported fields and automatically saved a scored assessment.
- A new rejection followup saved before analysis, then changed intent from A to C and forecast from 72% to 15% under the deterministic adapter. New advice referenced the rejection.
- Missing enterprise identity asked for clarification without creating a placeholder. Completing it detected the existing project; selecting it appended one followup instead of duplicating the project.
- Navigating away from an unfinished intake displayed the discard guard; cancelling retained the draft.
- Manager report generated and persisted factual event counts, excluded all seed projects and retained history. Report evidence uses readable field names rather than raw JSON.
- Simulated provider failure retained the raw followup and prior assessment, with failed/stale status rather than a fabricated new result.
- Real microphone capture was not activated during automated QA. Existing recognition/controller tests cover final-chunk assembly, stop/cancel and one-submit behavior; device support and microphone permission remain browser-dependent.
- Temporary local model configuration, synthetic project/events/report and test servers were removed; the pre-QA local workspace was restored. Hosted customer records and model settings were not used for these checks.

## Published automation

The unattended writer/readback contract, paging and retry rules are in `docs/operations/sales-daily-report.md`. Publication verification calls the private Site maintenance endpoint using supported service access, with no visitor impersonation, and checks the fresh persistent readback. The linked schedule is created only after that verification. Existing talk-track maintenance remains separate.

Intent scores and win estimates are sourced model assessments, not observed sales outcomes or statistically calibrated win rates. Report scope is the signed-in account workspace; the application does not claim enterprise-wide employee account aggregation.
