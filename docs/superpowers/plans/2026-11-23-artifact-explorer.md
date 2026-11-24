# Artifact Explorer from existing captured data

Status: Implementation complete; review and release follow steps 4–5 below, 2026-11-23. Owner: current Codex implementation session. Publication and live-delivery evidence belong to the owning PR and project task.

**Goal:** Open Artifact Explorer from a sidebar button as a full web page in the browser's main area. Help users find and follow captured artifacts across tools using metadata and relationships already recorded by Brauser.

**Architecture:** A bundled extension page uses native messaging to read a unique-artifact query and an artifact-context query from the existing rebuildable SQLite index. It needs no server, agent, permission, capture-policy change or authoritative-data migration. The host retains folder/configuration authority. Existing saved categories are displayed as categories, with their original meaning and uncertainty.

**Tech Stack:** Plain TypeScript/DOM, bundled CSS/HTML, existing HostClient, generated protocol v8 types, Rust/rusqlite and the current index read/catch-up path.

**Sources:** User's approved interactive concept and explicit build request using existing data; clarification that the sidebar launches a web page in the browser's main area; DESIGN.md sections 4, 5.1 and 5.5; docs/agents/safety.md; host/src/index/query.rs and recent_page.rs; protocol/schema.json; extension/tasks.ts, task-handoff.ts and native.ts; the existing Artifact Explorer improvement entry.

## Design challenge

- **Challenger:** Read-only host/query and frontend research agents in this session.
- **Alternative:** Reuse artifact-day Recent and deduplicate in the page; derive context from only the current page/card; build a local HTTP server; or defer the optional map.
- **Outcome:** Keep the unique-artifact and bounded context queries: page/card context omits outgoing and off-page relationships, and Recent deduplication cannot produce complete unique pages or latest-summary filters. A bundled page in a normal browser tab avoids an HTTP access boundary. Retain a small focused map from the approved concept, strictly derived from the same bounded connection response and selection action; the ordinary connection list remains available and accessible.

## Open decisions

- **Decision:** Launch surface. **Status:** resolved by the user, 2026-11-23: sidebar button opens a full web page in the main browser area. **Default if unresolved:** none; this is the explicit requirement.
- **Decision:** Runtime/data access. **Status:** resolved by coordinator: packaged extension page in a browser tab, reusing native messaging and local data authority. **Default if unresolved:** no new server or cloud storage.
- **Decision:** Available organization. **Status:** resolved by the request to use existing data: category, saved document type, source host, artifact type, reading coverage, title/overview/context text and recorded edges. **Default if unresolved:** unavailable fields are omitted, never invented.
- **Decision:** Editing labels. **Status:** resolved by coordinator as outside this existing-data slice: browse the recorded metadata read-only. Durable subject/tag overrides need the separate labelling design. **Default if unresolved:** no writes to saved records.
- **Decision:** Search. **Status:** resolved by coordinator: case-insensitive Unicode-aware text matching across title, source, overview and saved context; latest activity order, with no semantic ranking claim. **Default if unresolved:** no new model or FTS migration.
- **Decision:** Related artifacts. **Status:** resolved by coordinator: existing recorded containment, title mentions and valid navigation, followed by exact saved-category associations. Never infer citations, fixes or dependencies from those signals. **Default if unresolved:** show only explainable available evidence.
- **Decision:** Facet counts. **Status:** resolved by coordinator: complete captured-library counts, labeled as library facets; matching result count is separate. **Default if unresolved:** never claim a page's counts describe the entire library.
- **Decision:** Compatibility/deployment. **Status:** resolved by repository policy: additive v8 requests; old hosts get a rebuild/update message. Validate and merge host/extension together, then deploy the CI-green main commit through deploy-live and report Chrome-loaded status separately.

## Read and identity invariants

- Both new requests carry expected_revision and run under config.lock_current(), selected-folder identity verification and read_index(). A changed home/config refuses rather than mixing libraries.
- Explorer also sends an additive optional expected_revision on the existing open_summary request; the host compares it under its configuration lock before opening a file. Legacy callers retain their existing omission behavior.
- If an ordinary selection's refreshed context no longer matches the query, clear the preview and ask to refresh; deliberate connection traversal retains its explicit outside-filter notice.
- artifact_id is only a selector for an existing indexed row; no caller path or identity creates authority, artifacts or files.
- Normal index catch-up is permitted; the handlers do not regenerate artifact files or rewrite authoritative logs. These requests stay outside panel_request's interactive regeneration path; existing independent host maintenance retains its own contract.
- Page continuations bind filters, limit, folder/config identity and the full serialized result/facet snapshot. Changed evidence returns conflict and requires a fresh query.
- Hostile titles and summaries render with textContent. Source links allow only credential-free HTTP(S); generated UI/map nodes use DOM APIs and bundled code under the existing CSP.
- No record-ownership or history guard in config.rs changes; the randomized guard invariant contract is not applicable.

## Protocol contract

Use generated definitions from protocol/schema.json, then regenerate both Rust and TypeScript.

- ExploreArtifactsRequest / explore_artifacts: expected_revision; nullable query (256), source (253), artifact_type/category/document_type (64 each), nullable reading (limited/whole/unknown/none); limit 1–8; page as RecentPageRequest. Null reading means all, none means no saved summary, and unknown means a saved legacy summary without coverage.
- ExplorerArtifact: artifact_id, artifact_type, title, url, source host, first_seen, last_seen, focused_seconds, opens, nullable why and nullable SummaryView. It represents one canonical indexed artifact and its latest renderable summary across all days.
- ExplorerFacet: value and count. ExplorerFacets: sources, artifact_types, categories and document_types, each at most 64 values, plus truthful truncated flag.
- ExploreArtifactsResult / explore_artifacts_result: items (at most 8), facets, matching total, library_total, and RecentPageInfo. Stable ordering is last_seen descending, title and artifact_id.
- GetArtifactContextRequest / get_artifact_context: expected_revision and artifact_id.
- ArtifactContextResult / artifact_context_result: nullable item, at most 8 connections and truncated. Unknown IDs produce no item or connections.
- ExplorerConnection: artifact as ExplorerArtifact; basis (navigation/title_mention/container/same_category), direction (incoming/outgoing/associated), nullable transition and nullable recorded last_seen. Prefer the strongest recorded explanation per neighbor, then exact-category neighbors; cap unique neighbors and report more results truthfully.
- Bound full escaped responses below the existing native-message cap, including facets and maximal rows.

## Tasks

### 1. Host queries and protocol

- [x] Add the contract and generated output, strict extension response validation, host dispatch and guarded handlers.
- [x] Query canonical artifact rows with latest-summary selection, filters before pagination, complete library facets and a bound snapshot.
- [x] Read existing connections in both directions, exclude self/unresolved evidence, preserve evidence meaning and use exact-category matches only as associations.
- [x] Test unique multi-day rows, latest/legacy summaries, filters, Unicode, continuations/config changes, relationship meaning/caps, unchanged reads and response size.

### 2. Explorer page and sidebar launch

- [x] Add bundled HTML/CSS/controller/model and an accessible sidebar launch button that reuses an existing Explorer tab.
- [x] Implement library facets, search, pagination, selection/preview, original-source and owned-summary opening, empty/loading/error/old-host states and explicit refresh.
- [x] Reject stale list/detail replies and clear/reconcile selection on filters; mark deliberate related navigation outside current filters.
- [x] Present explained connections as a list and optional focused map, using the same returned evidence.

### 3. Product docs and UI verification

- [x] Update DESIGN.md, README, TESTING.md and generated current-state sources for the implemented contract.
- [x] Extend synthetic controller, transport and real-browser accessibility/keyboard fixtures. Inspect layout and interactions in the browser without private fixtures.
- [x] Reinforce the existing Explorer improvement entry with the concrete next improvement discovered during implementation.

### 4. Review and publication

- [x] Run focused checks and the applicable README gate, respecting the load rule; preserve failures and isolated reruns. The testing log records completed checks, the high-load stop and sidebar integration coverage.
- [ ] Scan source/commit/PR text, run the pushed-head Codex review alongside CI, resolve findings and use Mergify queue/watcher until merged.

### 5. Live delivery and handoff

- [ ] Verify the normal checkout's merged implementation, run the supported deploy-live dry run and deploy with active-run safeguards.
- [ ] Verify published and Chrome-loaded builds separately, update the tracker and report the user-visible launch path plus any remaining acceptance boundary.

## Lane ownership

- Host lane: protocol/schema.json, protocol generated outputs, protocol tests, extension/protocol-shape.ts and its guard tests, host/src/index/explorer.rs and focused tests, index/mod.rs and native.rs.
- Frontend lane: new extension/explorer* files and tests, build.mjs, sidebar launch changes and focused panel tests.
- Coordinator: this plan, product/status/testing docs, independent integration/a11y coverage, full gate, review/CI/merge/deploy and project tracking.
- Coordinate any shared fixture edit before writing it; all lanes work in this isolated artifact-explorer checkout.
