# Creative and Design Studio Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Verify each subsystem before publishing.

**Goal:** Add a marketing and interface design studio under AI营销素材.

**Architecture:** A shared typed document connects the content workspace, artboard editor, member-scoped D1 versions and templates. Existing member authentication, text models, media jobs and calendar remain the entry points to those services.

**Tech Stack:** React, TypeScript, Vinext, Cloudflare D1, browser Canvas, fflate.

**Spec:** [AI营销素材创作与设计](../specs/2026-11-12-creative-design-studio-design.md)

## Tasks

- [ ] Define the studio document and artboard types in `app/lib/creative-studio-types.ts`.
- [ ] Implement versioned D1 documents, market publication and typed generation at `/api/creative-studio`. Verify owner/member isolation, atomic revisions and protection against private asset sharing.
- [ ] Implement the artboard canvas, layer properties and offline exports. Verify authored content escapes safely, private images become local export files and PNG uses actual artboard dimensions.
- [ ] Add a native template market with authored templates for all four kinds, shared listings and removal of one's own listing. Verify selecting a template creates an independent draft.
- [ ] Join the studio with the existing materials tabs and dirty-state guard. Verify project persistence, content and image generation with mock responses, comparison and restoration, schedule creation and desktop/mobile layout.
- [ ] Run the scoped tests, type check and production build. Transfer the verified Git tree to the existing private Sites project, publish, and record the deployment.
