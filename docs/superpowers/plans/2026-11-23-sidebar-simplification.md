# Simplify the sidebar

**Goal:** Make page capture, notes and enriched Recent easy to scan without exposing routine configuration.

**Architecture:** Keep the existing host contracts and controllers; reorganize the panel shell, use native nonmodal popovers for secondary controls and share raised/inset surface tokens.

**Tech Stack:** MV3 HTML, CSS, TypeScript and headless Chrome accessibility fixtures.

**Sources:** User workflow; DESIGN.md §5.7; extension/panel.html, panel.css and panel.ts; current-state.md; merged Capture Site validation PR #518.

## Design challenge

- **Challenger:** sidebar audit subagent in this session.
- **Alternative:** Native `popover="auto"` instead of custom modal/focus trapping or absolutely positioned details.
- **Outcome:** Adopted; retain the visible task context, native Escape/light-dismiss, bounded scrolling and independent view scroll positions.

## Open decisions

- **Decision:** Preserve all built features through progressive disclosure. **Status:** resolved by the user's simplification request, 2026-11-23. **Default if unresolved:** no feature removal.
- **Decision:** Related-page search and richer metadata search are outside this visual change. **Status:** resolved from the shipped capability inventory; record them as gaps rather than inventing controls. **Default if unresolved:** preserve existing filters.
- **Decision:** Use subtle neumorphic elevation in both themes, with visible contours, readable text and focus indicators. **Status:** resolved by user direction, 2026-11-23. **Default if unresolved:** retain accessible theme contrast.

## Tasks

1. Fix header, tabs, independently scrolling views and bottom composer; move secondary controls into native Options/Activity popovers.
2. Apply consistent alignment and raised/inset surfaces; make Recent labels, importance and reading coverage scannable.
3. Verify all existing flows with focused tests, browser layout/keyboard coverage and the development gate; record feature gaps and a follow-up improvement.
4. Review, publish through the repository queue and deploy the merged main build through the supported runbook.
