# Knowledge document capacity increase

Goal: raise extracted knowledge text from 80,000 to 1,000,000 characters across browser parsing, paste, upload validation, splitting, atomic persistence and retrieval. File bytes remain at 10 MB and Excel archive safeguards remain bounded.

1. Add failing tests for large Excel, exact 1,000,000 boundary, request JSON size and complete ordinary/parent-child passage coverage.
2. Centralize text, request and chunk limits. Preserve contract review's 80,000 default while knowledge import opts into the larger limits.
3. Verify storage supports thousands of chunks atomically, with bounded vector reads and honest corpus scan limits; do not introduce partially published documents.
4. Check preview and processing remain usable for large documents. Keep the production Worker URL regression checks.
5. Run targeted and full tests, types, lint, production build and real browser worker checks; publish and sync CTYX.

Reference: https://developers.cloudflare.com/d1/platform/limits/ (batch is one invocation query; limits still apply per statement and total batch duration).
