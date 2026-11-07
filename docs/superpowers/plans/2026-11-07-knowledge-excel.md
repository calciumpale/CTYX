# Knowledge Excel Import Implementation Plan

> **For agentic workers:** Use the existing scoped import API; test parsing before changing the importer.

**Goal:** Import XLSX and XLS into knowledge libraries, preserving sheet names, source rows and formatted values for existing chunking and retrieval.

**Architecture:** Browser-local parsing with a pinned SheetJS CE build, dynamic loading and bounded XLSX archive validation. Worker API receives extracted text only; no database, embedding or permission changes. Preserve all sheet content including hidden sheets with explicit labels. Never calculate formulas or execute macros, links or embedded objects.

**Scope and decisions:** Extend the current text extraction path instead of adding a server upload service. Reject corrupt, encrypted and oversized workbooks without partial imports. Retain 10 MB file and 80,000 character limits; cap workbook sheets and populated cells. Formulas use stored values plus a warning; missing cached results remain explicit.

- [ ] Add real XLSX/XLS fixtures and failing import tests, including downstream worksheet headings.
- [ ] Add bounded XLSX preflight and workbook text extraction.
- [ ] Extend file picker and format copy, document limitations.
- [ ] Verify import/chunk/retrieval, full tests, typecheck, lint and production build.
- [ ] Publish the existing Site and sync private CTYX repository.

## Follow-up: quiet Douyin connection

The user additionally requested that connecting stop repeatedly opening browser pages. Evidence showed expired passive identity checks were navigating to profiles and missing proof eventually closed the browser. Passive checks now only inspect the dedicated existing page; explicit connection and send checks retain strict identity verification. Temporary misses retain the window and authenticated=false while retrying. Explicit invalid identity pauses without taking jobs. Doctor checks local configuration only. Preserve the existing profile; no use of arbitrary user browser sessions.

Verification: 860 tests pass with local intercepted browser fixtures; local Mac installer completed after the user quit, installed code hashes and signing verified. No real social messages were sent.
