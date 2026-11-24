# Outbound artifact links in page captures

**Goal:** When Brauser captures a page, retain a useful, bounded list of direct links on that page to other artifacts recognized by the user's enabled capture rules.
Include targets the user has not visited, without creating target activity.

**Architecture:** Collect direct anchor destinations from the captured document, prefilter them with the worker's current policy lease, and independently authorize and identify each target through the native host's current adapter document.
Persist a separate, replayable link observation alongside the source capture, derive its current list in the disposable index, and show it in the source artifact's Markdown and side panel.
Reuse existing capture delivery, ownership checks and Markdown helpers; discovering a link starts no agent or destination request.

**Tech Stack:** Chrome MV3 TypeScript extension, Rust native host/service, generated JSON-schema protocol, append-only capture logs, disposable SQLite index and offline synthetic fixtures.

**Sources:** [Safety invariants](../../agents/safety.md), DESIGN.md sections 4, 5.1, 5.2, 5.7 and 6; `extension/{worker,model,activity,extract,summarize,site-patterns}.ts`; `host/src/{config,native,capture,url_provenance}.rs`; `host/src/index/{db,fold,project,render,regen}.rs`; `host/src/service/{record,finisher}.rs`; and `protocol/schema.json`.

Status: proposed implementation plan, 2026-11-23.
Owner: coordinating implementation agent, with lane ownership assigned before code changes.
This document completes the requested planning work; runtime implementation, PR publication and deployment are separate next steps.

## Design challenge

- **Challenger:** Independent `challenge_artifact_links` reviewer in this planning session, supported by a separate capture-flow review.
- **Alternative:** Use a bounded DOM pass and the existing deterministic adapter matcher instead of an LLM, crawler, URL keyword classifier or inferred site rules.
  Keep link observations separate from measured activity rather than turn hrefs into visits or overload title-derived mentions.
- **Outcome:** Adopted.
  This gives the same recognition and scope boundary as capture, makes decisions reproducible, and avoids destination access or invented activity.

## Open decisions

- **Decision:** Which targets qualify? **Status:** Resolved by John, 2026-11-23: only artifacts recognized by enabled capture rules. **Default if unresolved:** Omit unrecognized destinations; never enable another site implicitly.
- **Decision:** Does outbound include same-site links and unvisited artifacts? **Status:** Resolved as the plan's recommended interpretation of "other artifacts": both qualify when their identity differs from the source. **Default if unresolved:** Keep this interpretation explicit for review.
- **Decision:** Which capture paths are covered? **Status:** Resolved for this plan by the coordinator: automatic artifact capture and manual/automatic Summarize & log, including Save Page on an unrecognized source. **Default if unresolved:** Add no writes to ordinary tasks, notes or kept-passage actions; extend a `/log` action only if its implementation is verified.
- **Decision:** What page region is read? **Status:** Resolved for this plan by the coordinator: rendered document anchors, including links outside the main article if their targets qualify; automatic capture uses the top document, and explicit summary capture uses its selected readable document frame. **Default if unresolved:** Do not aggregate unrelated frames or use network retrieval to fill gaps.
- **Decision:** What does a repeated capture replace? **Status:** Resolved for this plan by the coordinator: show the latest valid observation, its time and coverage, and retain older observations in history. **Default if unresolved:** Missing or unavailable extraction preserves the last known list; a successful empty scan replaces it with an empty list.
- **Decision:** Does this change target authorization or record ownership? **Status:** Resolved by existing safety invariants: no. **Default if unresolved:** Do not change `host/src/config.rs` ownership/history guards; any later need to do so requires a separate guard invariant and its prescribed randomized test.

## Product behavior

A captured document containing a ticket link, a document link and a pull-request link lists those recognized targets under **Outbound artifact links**.
An unrecognized search URL, login link, resource or ordinary web page does not enter that list.
The matcher, rather than a hand-maintained list of tool names or file extensions, decides whether a destination is an artifact.
Do not add a second route-word classifier: a repository root or subroute that an enabled adapter intentionally recognizes remains eligible.

| Link or state | Expected result |
| --- | --- |
| Same-site link to a different recognized artifact | Include |
| Cross-site link matching another enabled adapter and its account scope | Include |
| Recognized artifact never opened or summarized | Include in the source's list; create no target visit, Recent row, note or summary |
| Several hrefs for one artifact, including view/edit and tracking variants | One target, identified by the host |
| Link to this artifact, its fragment or an equivalent identity | Exclude |
| Disabled origin, out-of-scope account or unrecognized route | Exclude |
| `javascript:`, `data:`, `file:`, `mailto:` or credential-bearing URL | Exclude |
| HTTP(S) link whose suffix looks like a file | Include only if enabled rules recognize an artifact; a suffix alone is insufficient |
| Extraction blocked, page changed, or no DOM access | Capture remains usable; show link coverage as unavailable |
| Anchor, time, item or byte limit reached | Retain a bounded partial list and show that it is partial |
| Older capture without link data | Show that links were not collected; do not present it as a measured empty list |

Anchor text is an optional untrusted label, not a verified destination title.
Prefer a known recorded title when available, otherwise the label or host-derived artifact identity.
Do not fetch targets, resolve shorteners/redirects, unwrap unknown tracking links, click controls, scroll to load content or infer canvas-only links.
Hidden anchors, application-resource tags and unrelated iframe content are outside the collection scope.
"Complete" means the bounded eligible anchors in the rendered document were scanned, not that a virtualized document or remote file was fully read.

## Data and lifecycle contract

1. An observation records a stable observation ID, source capture reference and host-derived identity, source URL, observation time, document/frame scope, policy revision, coverage and a bounded set of targets.
   Each retained target has a host-derived artifact ID/type, normalized HTTP(S) URL and optional plain label.
   Use explicit coverage states `complete`, `partial` and `unavailable`, plus bounded reason codes; absence means legacy/not collected.
2. The extension resolves relative hrefs using the observed document's effective base URL and applies current lease matching before buffering or transport.
   The host derives identities from the original authorized target URL before normalization, then applies the existing URL bounds, fragment removal and configured parameter stripping.
   No generic `web.page` fallback or retired note-identity contract can authorize a target.
3. Deduplicate by target artifact identity, in first-observed order, and remove source identity matches.
   Apply any already-validated identity projection consistently; do not introduce a new alias-inference mechanism.
   On a duplicate, keep the first nonempty bounded label and safe URL rather than concatenate page text.
4. Link observations are optional enrichment with a separate admission result and a durable `links_to` log record, reusing the checked capture writer and recovery machinery.
   Bind an observation to an accepted source activity capture or saved-summary capture; do not let its message create an arbitrary source record.
   An unavailable or rejected observation cannot invalidate successful source activity or a saved summary.
   Do not weaken existing whole-activity checks: validate every claimed target or reject the entire observation, with no silent filtering of malformed evidence on the host.
5. For automatic capture, collect once after a recognized main-frame navigation or SPA transition has settled and the document is ready, with one bounded retry for a loading document.
   Also collect at an explicit or automatic summary capture.
   Use existing document/navigation generations, expected URL and policy checks before and after extraction; late results after navigation, pause, removal or tab reuse are discarded.
   This is a snapshot at capture, not continuous DOM surveillance.
6. Preserve a stable serialized observation after dispatch, retry the same bytes/ID after lost replies, and make duplicate acceptance idempotent.
   Before dispatch, refresh lease/pending-removal checks and discard unauthorized target candidates with a visible partial/unavailable result rather than misreport completeness.
   After dispatch, changed policy may refuse the observation; it never permits a frozen payload rewrite.
7. Persist only normalized target URLs and names-only stripped-parameter provenance.
   Extend provenance validation, history readers, identity/relearning impact analysis and protected-field handling for nested target URLs.
   Never retain removed query values or raw href collections in debug logs, run records or the durable source capture.
   Rebuild the same capture-time list from stored checked observations, without silently reclassifying historical links under later adapters.
8. Order snapshots by observation time, using observation ID as a deterministic tie-breaker, so delayed delivery cannot replace a newer observation.
   An unavailable observation updates the collection status and preserves the last successful list and its original timestamp.
   A partial observation replaces the displayed list with its explicitly partial result, never silently unioned history.
   A complete empty observation clears the current list.

Start with limits of 500 inspected anchors, 100 distinct retained targets, 8,192 bytes per URL, 256 characters per label and 64 KiB of encoded observation data, including its envelope.
Use a bounded traversal/deadline and never clip a URL to fit; omit a whole target and report partial coverage.
These are proposed product bounds to verify with synthetic dense pages and worst-case JSON escaping before implementation acceptance.
Reserve bounded enrichment capacity separately from activity's existing 512 KiB/256-event queue so link data cannot displace measured activity.
Coalesce only observations not yet dispatched; expose any dropped pending observations as collection gaps.
Verify complete request, response, batch and intent sizes, including the existing 4 MiB inbound and 900 KiB outbound native-message ceilings.

## Tasks and ownership

### 1. Define and implement the checked observation contract

Owner: coordinator/host lane.
Depends on: the decisions above and an overlap check for every shared file.

- Add bounded observation request/result and view types to `protocol/schema.json`, regenerate both languages, and document additive compatibility and older-host refusal.
- Add a dedicated host admission path with current locked config/home checks, source-capture binding, independent target authorization, safe normalization and names-only provenance.
- Reuse capture intent/log append and retry guarantees for the new record; cover the boundary where source save succeeds and observation save fails.
- Keep source authority distinct: automatic observations require active automatic capture; manual summary observations inherit only that explicit capture's source authority, while targets still need enabled rules.
- Acceptance: forged identity/source claims, malformed provenance and excessive items/bytes fail before home I/O; source capture success is preserved on observation failure; old records replay unchanged.

### 2. Collect links in the extension's capture paths

Owner: extension capture lane.
Depends on: task 1's generated contract; can prototype the pure collector independently with synthetic fixtures.

- Add a lightweight self-contained DOM collector, using `extension/site-patterns.ts` only as a bounded-traversal reference.
  Do not reuse its shape-only results as raw URL evidence or run Readability on every navigation.
- Integrate collection with `worker.ts` document lifecycle and `summarize.ts`/`extract.ts` selected-frame extraction, retaining source identity checks and separate text/link completeness.
- Prefilter with the current lease, implement bounded retry and race invalidation, and deliver an observation through the existing capture retry lifecycle with its reserved budget.
- Persist a summary capture's bounded pending observation outside model-controlled output so joining an existing run, closing the panel, cancellation, a wall or failed summary publication cannot attach it to another source or lose its attribution.
  A newly created summary run owns one host-validated and normalized pending observation; a request that joins that run preserves its original observation and discards the joining request's candidates.
  Retained run state holds checked normalized targets only, and publication follows successful persistence of that run's source summary capture.
  A cancelled run or summary wall publishes no observation; an observation-write failure after a saved summary remains separately retryable.
  Ordinary page-attached tasks reuse reading code but create no link record.
- Acceptance: same-origin and cross-origin targets are retained, disabled/unknown candidates never enter durable buffers, and stale DOM results cannot cross a navigation, policy or capture boundary.

### 3. Derive, rebuild and render the captured link list

Owner: storage/index lane.
Depends on: task 1's stored representation; may run alongside task 2.

- Extend log readers, incremental index updates, full rebuild and source dirtying for capture-time observations and separate `links_to` relationships.
- Keep checked target metadata on source observations so an unvisited target is visible without an `artifacts` row or fabricated activity.
  Do not rely on today's `linked_count`, which counts recorded peers, as the new list's source of truth.
- Add the latest list, coverage and observation time to the host artifact view and ownership-checked generated artifact Markdown.
- Audit every edge consumer: outgoing links must not appear as incoming navigation, measured opens/focus, worklog activity, title mentions or containment.
- Acceptance: full rebuild and incremental updates agree after shuffled/duplicate deliveries, successful empty snapshots, unavailable snapshots and target later becoming visited; source notes and old capture bytes remain untouched.

### 4. Show the list with the page capture

Owner: extension presentation lane, coordinated with the storage lane on generated types.
Depends on: tasks 1 and 3; panel fixtures may run in parallel.

- Add a separate **Outbound artifact links** section to the source artifact panel, with target label/type, safe external link, observation time and coverage notice.
- Include the checked list in the host-written captured-artifact representation; if surfaced beside a saved summary, render it from the host observation, not agent-proposed references.
  Keep the saved summary's own capture-time reference rather than silently showing a newer page snapshot as part of that summary.
- Cover empty, unavailable, partial, legacy and target-not-yet-visited states; refresh after observation delivery and suppress late replies after page/home/config changes.
- Use `textContent` and existing host Markdown destination/inline helpers; page text supplies neither HTML nor an output path.
- Acceptance: the list remains useful with no summary harness configured and never implies that following a discovered link is authorized agent retrieval.

### 5. Validate and land the feature in reviewable increments

Owner: coordinator, with focused checks owned by each lane.
Depends on: tasks 1–4.

- Land checked transport/storage prerequisites before enabling collection, then activate collection and presentation together after end-to-end synthetic checks.
  Keep shared-module changes incremental and assign actual file ownership before parallel edits.
- Cover the acceptance matrix below, update DESIGN.md and affected TESTING.md guidance, and regenerate current-state documentation only once behavior ships.
- Run protocol generation checks, focused extension/host/index tests, document checks and privacy scan.
  Run the Markdown corpus if neutralization changes and adapter-diff if either matching engine changes.
  Run the README gate subject to its load limit and keep Windows CI checks intact.
- Before each PR, run overlap checks and the repository's review/owner/privacy steps; merge through Mergify and watch to completion.
  Runtime deployment then uses the main checkout's supported deploy-live runbook, with built, published and Chrome-loaded evidence reported separately.

## Acceptance matrix

| Area | Required synthetic evidence |
| --- | --- |
| Recognition | Mixed recognized ticket/doc/PR/repository targets survive; unrecognized roots/search/settings, disabled sites, wrong accounts and unknown URLs do not |
| Identity | Relative hrefs, base URL, same-site targets, repeated mode/tracking variants and self-fragments produce the expected unique target IDs |
| Trust/privacy | Unsafe schemes, userinfo, forged IDs, injected labels, lossy query normalization and stale leases are safely refused or prefiltered at the correct boundary |
| Source lifecycle | Automatic navigation, SPA changes, manual/automatic summaries, panel close, joined summary run, summary wall/save failure, pause and site removal keep the right attribution |
| Coverage | Dense page, hidden anchors, restricted/selected frames, virtualized content, successful empty, unavailable and partial results remain distinguishable |
| Durability | Lost replies, restart, interrupted append, duplicate/conflicting IDs, delayed observations and deleted index reproduce the same accepted snapshots |
| Measures | Recognized unvisited destinations appear only in the source list and never gain opens, focused time, visits, Recent entries or user notes |
| Bounds | Worst-case Unicode/escaping fits observation/native/response/queue/journal limits without clipping URLs or displacing activity |
| Presentation | All labels/destinations remain inert; navigation/home/config changes suppress stale views; older captures show not-collected status |

Use temporary folders, fake harnesses and disposable synthetic browser fixtures only.
No real account browsing, destination fetching, platform opener, `launchctl` or user support folders are needed to validate this feature.

## Suggested follow-up

Make link coverage inspectable: retain the number of anchors inspected and a bounded limit/failure reason alongside the retained artifact-link count.
This helps a user distinguish "this capture has no qualifying links" from "Brauser could read only part of this page" without keeping rejected hrefs.
The proposal is recorded in the repository improvement feed; it can be implemented inside the feature's coverage contract rather than as a separate project.
