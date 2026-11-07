# Navigation and AI Naming Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for the assigned tasks. Implementation is already authorized; keep the shared worktree and do not commit.

**Goal:** Use the exact product name 营销工作台, simplify business navigation and make AI capabilities recognizable in context.

**Architecture:** Keep page IDs, routes, data and server permissions intact. The navigation registry owns business sections and role visibility; the shell presents those sections and their contextual pages. Update visible copy and product/design documentation together.

**Tech Stack:** React, TypeScript, Vinext, existing neutral CSS tokens.

**Spec:** `PRODUCT.md` navigation and naming rules; `DESIGN.md` visual and copy rules.

## Global Constraints

- Product name: 营销工作台. Remove CTAI from current product branding; add no slogan.
- Business primary navigation, in order: 抖音获客、项目跟进、培训提升、知识库. These categories have no AI prefix.
- Project work contains project lists, follow-up recording, meetings, approvals, contracts and manager-only reports. Overview remains reachable through the brand and project subnavigation.
- Personnel, rules, service connections, builder and run records remain available under system management with existing role boundaries.
- Visible capability names: AI 客户洞察、AI 策略方案、AI 商机预测、AI 合同初审、AI 销售陪练、AI 会议纪要.
- Preserve business functionality, route/agent IDs, persisted values, direct links and server authorization.
- Keep the compact neutral Linear direction, responsive navigation and accessible focus. No decorative left accent bars.

## Review Focus

- Every role sees only authorized entries, including direct URLs and manager-only reports.
- Entering a project-related direct link highlights 项目跟进 and leaves its subnavigation available.
- Follow-up creation still opens the existing project workflow with its context intact.
- Desktop, mobile drawer and bottom navigation expose the same authorized business structure.
- Branding and visible AI labels agree across loading, login, shell, page titles, quick actions and documentation.

### Task 1: Navigation and shell

**Files:** `app/lib/workspace-navigation.ts`, `app/components/Workbench.tsx`, navigation CSS, `tests/workspace-navigation.test.ts`.

**Interfaces:** Preserve `canOpenWorkspaceView`, `workspaceTitle`, `readWorkspaceRoute` and `workspaceSearch`; use registry helpers for primary, project and system navigation.

- [x] Add and run focused navigation assertions for the exact four labels/order, project contexts, manager-only reports and existing role/direct-link restrictions.
- [x] Present the four business sections, contextual project pages and authorized system entries; keep overview and follow-up actions reachable.
- [x] Verify the focused tests and inspect desktop/mobile navigation, selected states and accessible labels.

### Task 2: Branding and contextual AI labels

**Files:** `app/layout.tsx`, `app/components/WorkspaceLogin.tsx`, business page components and visible agent labels.

**Interfaces:** Keep component props, action handlers, agent IDs and storage schemas unchanged; alter visible labels only.

- [x] Replace current app branding with 营销工作台 and remove redundant slogans.
- [x] Apply the six agreed AI capability names to the corresponding headings and entry points; retain ordinary business category names.
- [x] Inspect the changed copy and run typecheck; confirm project, training, meeting and contract actions still use their original handlers.

### Task 3: Documentation and integration verification

**Files:** `DESIGN.md`, `PRODUCT.md`, `README.md`, `.impeccable/design.json`, this plan.

**Interfaces:** Preserve the design JSON schema and existing tokens; document the navigation hierarchy and naming rules.

- [x] Align the exact product name, primary order, project/system structure, AI naming glossary and role boundaries across current product documents.
- [x] Parse `.impeccable/design.json`, inspect the final diff and check for obsolete branding in changed product surfaces.
- [x] Run the appropriate navigation tests, typecheck, token checks and existing regression suite; record actual results and remaining limitations in the handoff.

## Verification evidence

- Full root regression suite with browser fixtures: 766 tests passed, 0 skipped, 0 failed.
- Navigation tests: 5 passed. Typecheck and token validation passed; token check covered 65 files with 0 errors.
- Local browser checks covered sales, manager, admin, desktop and 390px mobile; exact business order, manager-only reports, admin management entries, followup route intent, project detail/list transitions and draft-leave confirmation.
- Active training navigation retains an unsaved setup value. Mobile drawer hides the bottom bar and its logout control works. No outbound customer messages or paid model requests were made for verification.
- Independent navigation review: SHIP after restricting same-view resets to guarded project navigation.
