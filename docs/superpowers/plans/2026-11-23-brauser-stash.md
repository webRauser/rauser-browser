# Brauser Stash

**Goal.** Save the current page for later and browse saved pages in Brauser Stash. Mark a page done while keeping its files.

**Architecture.** The native host creates one Markdown receipt per summary record key in the selected home. The sidebar reuses an owned summary when present or starts the normal summary workflow. The full browser tab reads receipts and owned summaries using native messaging and shares Artifact Explorer's stylesheet.

**Tech Stack.** Chrome MV3, TypeScript, Rust native messaging and the existing summary service, local Markdown.

**Sources.** [Product design](../../../DESIGN.md#54-stash), [Artifact Explorer](../../../DESIGN.md#55-related-pages), [safety invariants](../../agents/safety.md).

## Design challenge

- **Challenger.** Current implementation session, reviewing the design before editing.
- **Alternative.** Put the saved flag in summary frontmatter and reuse the artifact index for browsing.
- **Outcome.** Explicit, create-only receipts preserve an item's first save and completion across ordinary summary replacement and index rebuilds. They also let a refused or interrupted summary leave a visible, retryable item without a new agent job type.

## Decisions

- **Name and surfaces.** The user's Stash action and separate Brauser Stash tab use the Artifact Explorer design. The sidebar provides both launch controls.
- **Summary.** Reuse the owned summary for the same key. A missing summary uses Summarize & log and its existing retry and cancellation controls. Pending items show that a summary is still needed.
- **Completion.** Append a completion receipt tied to the exact saved entry. Keep both receipts and the summary available through the Done filter.
- **Scope.** Use the selected home and the existing explicit-summary identity. Browsing, completing and reusing an existing summary need no harness.

## Implementation

1. Add native Stash messages and implement bounded, revision-checked writes and listing.
2. Wire both sidebar controls and build the Stash tab using the Explorer stylesheet.
3. Verify saves, duplicate aliases, recovery, completion, conflicts, and the browser flow before release review.
