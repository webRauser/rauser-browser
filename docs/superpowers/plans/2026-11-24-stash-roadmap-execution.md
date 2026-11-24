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

- [x] **1A. Queue layout and keyboard journey.** Make To read, Done and All directly visible. Use a responsive compact queue and detail view with a visible return path and preserve query, loaded range, selected row, focus and scroll on same-home refresh. Separate Stash CSS from shared Explorer layout. Cover empty, loading, no matches, host errors, 320/640/900/1200 CSS pixels, zoom, long titles, both themes and an item beyond page one. A failed or exhausted replacement retains the previous view with feedback. A selected item missing only from a fetched prefix is still unresolved. [PR #575](https://github.com/webRauser/rauser-browser/pull/575)
- [ ] **1B. Summary coverage and recovery.** Project coverage from the owned file and distinguish missing, unknown, page only, partial and whole. Keep link persistence usable when summary work is unavailable or the expected summary file is occupied. Surface a checked Retry summary action and lifecycle feedback when observable. Validate unknown legacy scope, summary path ownership, changed revisions, redirected sources and repeated starts. Coordinate the native contract and browser integration with the 1A lane.
  - The unchanged extension rejected the new optional scope field in the private test, so ship the native projection and strict validator with the preview. Pair the short saved date and limited-coverage cue in the results.
  - Coverage preview, durable link persistence and explicit retry share one PR after 1A. [PR #579](https://github.com/webRauser/rauser-browser/pull/579) contains the verified combined candidate. Track installed acceptance after an exact paired host and extension update.

## Loop 2. Reversible triage and personal priority

- [ ] **2A. Durable transitions.** Specify the supported restart, retry and downgrade behavior before implementing version-bound complete, reopen and pin transitions. Check late acknowledgements, idempotency and concurrency across native hosts. Legacy receipts retain their meaning and conflicting or unowned occupants are left intact.
  - A synthetic trial with two unchanged predecessor processes showed that archiving the active completion allows an old request to recreate Done. A config-only guard was removed by normal same-home picker repair. Prove a Stash-specific compatibility barrier tied to the home before activating divergent reading state. Keep pin state independent so it can use a compatible format without changing legacy reading state.
  - The completed structural layout refused all 25 legacy Stash requests across running, fresh, repaired and separate-config hosts. Notes and reindex still worked. That trial does not establish that relocation is safe while an older host holds an open directory. Prepare a Stash-only additive guard first. The supported deploy script only fast-forwards main, which gives a starting point for proving a release floor. Verify prepared-host refusal and cutover behavior before introducing a marker that activates new reading state. The test-only APFS proof serialized two independent configs using the checked home handle, including contention, a holder crash, and a waiter that rechecked the marker. It also confirmed that the guard-only build bypasses the lock. Ship the refusal guard separately. Activation requires proved managed quiescence and a rollback floor, or a validated common barrier used by all supported writers.
- [ ] **2B. Queue actions.** Add Undo, Move to To read, Pin and useful ordering. Keep source actions reachable and move focus to the nearest surviving item after completion. Test a transition from a later page, repeated clicks, stale views, and independent pin and reading state.
  - Prepare Pin as its own state change, preserving the saved time, summary and existing Done receipts. Keep Undo and Move to To read tied to the verified reading-state format. Private native Pin passed the ownership, legacy wire, stale mutation and pin-first paging checks. A second tab can change a plain continuation ID’s rank. Bind pin-aware continuations to the ordering and revalidate the loaded tail when it changes pin groups.

## Loop 3. Retrieve saved context

- [ ] **3A. Owned-context search.** Search summaries and then saved notes by record key, with safe snippets and result-source labels. Use source, type and coverage filters before paging and keep Done available through All. Cover stale cursors, missing and unowned files, aggregate byte and time budgets, and a content-only match beyond the first page. Show an explicit limit result if the budget is exhausted.
- [ ] **3B. Performance and acceptance.** Record synthetic 20, 200 and 2,000 entry measurements for current and revised first-page and incremental searches. Check bounded work and adopt indexing only if it is warranted by the measurements. Run the mixed-queue save, retrieve, coverage, completion and return journey. Assess whether concrete evidence justifies a separate export or offline-copy design.

### Search baseline

The benchmark at `a027c8e3` used the optimized host on local APFS, three serial processes and 120 timed warm requests per applicable case. It timed framed native request handling through reply flush, including the configuration lock, selected-home validation, receipt reads, filtering, sorting and summary projection for displayed rows. It excluded browser debounce, transport and rendering. The temporary fixture used valid save and completion receipts and varied owned summaries in each mixed synthetic home.

| Entries | Title first p95 | Source first p95 | Title next p95 | Source next p95 |
| ---: | ---: | ---: | ---: | ---: |
| 20 | 7.6 ms | 8.6 ms | No continuation | No continuation |
| 200 | 25.8 ms | 24.4 ms | 25.1 ms | 26.5 ms |
| 2,000 | 1,447 ms | 1,884 ms | 1,802 ms | 1,723 ms |

The fastest run still ranged from 626 to 989 ms at 2,000 items across these paths. A 2,000-entry miss reached 1,741 ms p95 for a 94-byte reply. Ambient load and first-read time varied. The current host scans and sorts receipts on each request, including continuations. Use 250 ms warm native p95 on the 2,000-entry mixed fixture as a working target, with first-read times tracked separately. Profile files and bytes opened, lock hold time and budget exhaustion before choosing a storage change. Measure sparse summary and note matches separately because the baseline only opens summaries for displayed rows.

The follow-up profile on the same fixture attributed 98.1–99.0% of native elapsed time to the scan across 15 warm requests. Each request checked 2,000 receipts and read about 1.1 MB of logical receipt data. Sort medians were 0.21–0.22 ms. The 345–367 ms native medians reflect this single profiled run. Test one validated receipt scan reused for subsequent requests, with explicit invalidation on home, receipt or cursor changes and bounded owned-content work. Measure the initial scan separately. Consider a rebuildable metadata index if this experiment leaves first-page or miss requests over budget.

The one-scan experiment matched the native results and cursors across 60 repeat queries with 1.6–2.4 ms medians. The one measured acquisition plus first title response took 386 ms. The in-place edit kept the directory modification time and initially returned a stale title. A simulated event invalidated it, but production event delivery remains unmeasured. A sparse owned-summary search resumed after an explicit byte limit and found its hit. Before choosing a reuse mechanism, prove freshness for real external edits and across native connections. Compare a rebuildable index if a fresh complete response still misses the target. Profile note access and exhaustive content misses separately. A disposable APFS probe validated the cheaper fingerprint check against a real edit from a separate process. Editing a file without changing its size and restoring its mtime preserved the parent metadata, while the file change timestamp still moved. Sixty warm metadata-only scans across two trials measured 13.5–18.2 ms p95 for 2,000 entries. This supports a native prototype with an unchanged full-read fallback. Verify exact parity and platform change tokens before relying on this technique.

## Loop records

- **1A review.** Reproduced a range gap when a new save displaces the last of exactly two loaded pages. The first fix retains the prior tail and scroll anchor. Re-review reproduced a different case when an unselected tail legitimately leaves To read. Accept a replacement only after it includes the tail or establishes that paging has gone past its saved order. Keep both browser regressions.
- **1A merged.** [PR #575](https://github.com/webRauser/rauser-browser/pull/575) reached main at `870c9b54`. The fix uses a strictly older parsed saved time to prove the refresh passed the prior tail. Equal millisecond timestamps keep scanning within the existing budget. The final head passed re-review and all 19 focused browser tests. Accessibility and Windows CI passed and Mergify verified the change on top of main. Three service tests timed out in the concurrent local workspace run. Their exact isolated reruns and both affected service modules passed. Installed Chrome verification remains part of release acceptance.
- **1B preview proof.** The private host, validator and preview work passed 20 browser cases through the extension validator, 15 native Stash tests and 104 wire tests. A Git merge rehearsal against the final 1A candidate found no conflicts. Verify that combined behavior on a branch from main before opening the preview PR.
- **1B saved-link proof.** The private host and panel work persists the link before checking its summary. The paired reply distinguishes a file conflict from a temporary access failure and starts no summary run for either. The change passed 17 focused host tests, 104 wire tests and 38 focused extension tests. Its single commit delta applies cleanly to the private preview. Pair it with the recovery UI and rerun the integrated checks before publication.
- **1B recovery proof.** The private combined candidate passed 24 browser cases. Retry followed a synthetic redirect without starting extraction or a run. Returning to Stash preserved the selected row and moved focus to the new Open summary action. Replaying the five in-scope commits onto the final 1A head reproduced the same tested tree. Publish them together after 1A lands.
- **1B publication.** The combined tree matched the private candidate and passed 17 native Stash tests, 104 wire tests, 38 focused extension cases, 24 focused Stash browser cases and the full 126-case accessibility suite. The full local browser suite took 19m 40s. The required full gate can run in CI when concurrent local load exceeds the repository threshold.
