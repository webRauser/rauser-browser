# Brauser Stash roadmap execution

**Goal.** Deliver the Stash reading queue, trustworthy summary preview, reversible triage and search across saved context. Preserve ownership and history from existing Stash homes.

**Architecture.** Keep Stash presentation independent of shared Explorer layout. Use the existing native host, home grants, record keys, summary pipeline and note readers. Land additive native contracts with their extension consumers. Retain original save and completion receipts.

**Tech Stack.** Chrome MV3, TypeScript, Rust, native messaging, local Markdown, Playwright and axe.

**Sources.** [Roadmap and baseline](../../history/2026-11-24-stash-design-review.md), [Stash contract](../../../DESIGN.md#54-stash), [safety invariants](../../agents/safety.md), [verification](../../../TESTING.md#brauser-stash).

## Design challenge

- **Challenger.** Independent Codex design review of baseline `c9a954ff`, 2026-11-24.
- **Alternative.** Ship the queue with finite refresh buffering and preserve the existing view when a batch fails or exhausts its budget. For summary recovery, open the validated source and require the ordinary summary gesture on the loaded tab. For requeue, consider how older hosts still interpret the legacy completion receipt before relying on a state sidecar.
- **Outcome.** Adopt bounded refresh, a preserved scroll anchor and explicit incomplete-refresh feedback. Split summary coverage and independent link persistence from the retry handoff. Use a second explicit gesture for recovery until a one-click path can carry checked tab, document, configuration and record identity through service acceptance. Compare downgrade-safe completion designs before Loop 2. Measure aggregate owned-file I/O and make a search-budget failure visible in Loop 3.

## Decisions

- **Navigation.** Use explicit row activation and a visible Back to results control. Keep To read, Done and All. Preserve same-home list state and keep the two-way keyboard journey within two navigation steps per direction.
- **Ownership.** Use the host-derived key and owned files for coverage, search and state. Do not grant folder, network or capture authority through a saved item's text or path.
- **Retry.** Stash opens the validated source for a second explicit summary gesture on the loaded tab. A one-click launch needs a checked context at service acceptance. Leave automatic retry, background fetching and live harnesses outside synthetic verification.
- **Durability.** Preserve the original save, completion evidence and summaries across requeue and pin. Resolve the exact versioned state format and concurrency token in Loop 2. If older hosts would silently misread the state, use a format they understand or prove a compatibility fence before publication.
- **Search.** Benchmark bounded owned-file search at 20, 200 and 2,000 entries. Choose an index only if the measurements support its cost and rebuild contract.
- **Deferred scope.** Evaluate export when there is a concrete transfer workflow. Record offline copies, position, highlighting, bulk actions, reminders, import, feeds, audio, sync and a second note editor as evidence-gated in the roadmap.

## Workflow

The coordinator owns the roadmap, this plan and shared documentation. Each work lane has its own worktree, checked paths, owner, bead and proof. Prepare independent work in parallel. As a shared surface becomes available, recheck its actual owners and baseline before opening a dependent lane. Keep Changes, Review, Validation, Merge and documentation progress separate in the loop record. An item is complete after its reviewed change is verified on main.

At the end of each loop, run the repository code review on the final head and record findings and their disposition. Run focused checks and the applicable README gate, or record the load-based CI split. Update the roadmap checklist and plan with the merged PR, evidence and any revised design choice. Use the existing merge queue and close beads after verification on main.

## Loop 1. Browse and understand saved pages

- [ ] **1A. Queue layout and keyboard journey.** Make To read, Done and All directly visible. Use a responsive compact queue and detail view with a visible return path and preserve query, loaded range, selected row, focus and scroll on same-home refresh. Separate Stash CSS from shared Explorer layout. Cover empty, loading, no matches, host errors, 320/640/900/1200 CSS pixels, zoom, long titles, both themes and an item beyond page one. A failed or exhausted replacement retains the previous view with feedback. A selected item missing only from a fetched prefix is still unresolved.
- [ ] **1B. Summary coverage and recovery.** Project coverage from the owned file and distinguish missing, unknown, page only, partial and whole. Keep link persistence usable when summary work is unavailable or the expected summary file is occupied. Surface a checked Retry summary action and lifecycle feedback when observable. Validate unknown legacy scope, summary path ownership, changed revisions, redirected sources and repeated starts. Coordinate the native contract and browser integration with the 1A lane.

## Loop 2. Reversible triage and personal priority

- [ ] **2A. Durable transitions.** Specify the supported restart, retry and downgrade behavior before implementing version-bound complete, reopen and pin transitions. Check late acknowledgements, idempotency and concurrency across native hosts. Legacy receipts retain their meaning and conflicting or unowned occupants are left intact.
- [ ] **2B. Queue actions.** Add Undo, Move to To read, Pin and useful ordering. Keep source actions reachable and move focus to the nearest surviving item after completion. Test a transition from a later page, repeated clicks, stale views, and independent pin and reading state.

## Loop 3. Retrieve saved context

- [ ] **3A. Owned-context search.** Search summaries and then saved notes by record key, with safe snippets and result-source labels. Use source, type and coverage filters before paging and keep Done available through All. Cover stale cursors, missing and unowned files, aggregate byte and time budgets, and a content-only match beyond the first page. Show an explicit limit result if the budget is exhausted.
- [ ] **3B. Performance and acceptance.** Record synthetic 20, 200 and 2,000 entry measurements for current and revised first-page and incremental searches. Check bounded work and adopt indexing only if it is warranted by the measurements. Run the mixed-queue save, retrieve, coverage, completion and return journey. Assess whether concrete evidence justifies a separate export or offline-copy design.

## Loop records

No implementation changes have merged for this roadmap yet.
