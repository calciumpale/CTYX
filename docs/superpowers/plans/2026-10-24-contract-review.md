# Contract Preliminary Review Implementation Plan

**Goal:** Make contract preliminary review discoverable and functional under the commercial risk expert, with precise source markings and concrete revisions.

**Architecture:** Reuse current project permissions, encrypted model connection, JSON workspace persistence and mutation queue. Add a dedicated contracts view and project entry. Browser-local import extracts TXT/DOCX/text PDFs before saving contract text; no external OCR is implied. A pure model review service segments all source text, validates exact quote offsets, and returns structured issues and omissions. Saving changed inputs invalidates earlier analysis. Findings have human-set handling status; nothing signs, approves or automatically replaces a contract.

**Tech Stack:** Existing React/TypeScript/Workers/D1 and Open Claude UI tokens. File parsing dependencies selected by current browser compatibility and bounded extraction.

## Constraints and implementation decisions
- Defaults: contract type selectable, party unspecified until user chooses, review focus optional. No assumed governing law or park-industry restrictions.
- Max 10MB import / 80,000 text characters, clearly fail unreadable scans/encrypted files/oversized text; no truncation or hidden skipped pages.
- Side-by-side source and findings on desktop; selectable source/results on mobile. Full original quote highlights use source offsets, not arbitrary HTML. No decorative left accent bars.
- Review requires a real configured model; drafts can save without it. Invalid model response or anchors cause failure without overwriting existing saved review.
- Every reviewed clause is accounted for. Missing clauses are separate unanchored suggestions. Chunked coverage limitations are explicit. Model cannot invent legal citations, source quotes, company authorizations or claim final legal approval.
- Project visibility applies to drafts, reviews, findings, and model context. Client cannot submit analysis/status/author fields in contract_save.

## Ownership and contract
Shared app/lib/contract-types.ts defines ContractDocument/ContractAnalysis/ContractFinding. State.contracts?:ContractDocument[], ApiResult.contractId?:string, View adds contracts. contract_save {id?,version?,dealId,title,text,contractType,ourParty,focus,fileName?,sourceFormat?,importWarnings?}; contract_review {id,version}; contract_finding_status {id,version,findingId,status:open|revised|legal}.

1. Pure review core + regression tests for exact anchors/empty or malformed output, chunk coverage, injection boundaries and general industry context.
2. Browser import + bounded file validation tests, TXT/DOCX/PDF supported only when extraction succeeds entirely.
3. Independent ContractReviewView and scoped CSS; source highlights, severity filters, editable drafts, replacement copy and human handling states.
4. Root domain/server permissions/persistence, mutation integration, risk expert description/context, nav and project entry.
5. Meaningful unit regressions, all existing tests/typecheck/tokens/build, bounded desktop/mobile/light/dark UI QA, independent review, publish same private Site preserving existing schedule and connections.
