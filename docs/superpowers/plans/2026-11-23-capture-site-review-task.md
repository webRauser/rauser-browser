# Capture Site review task

**Goal:** Every completed initial Capture Site setup launches a persistent task to inspect the site in a headless browser, improve and validate capture rules, and expose progress through a compact Tasks link.

**Architecture:** Reuse the existing `site_draft` queue and run records with an explicit capture-review context. Keep browsing evidence in the run input and result. The service delegates validation and publication to host-owned configuration code, preserving revision, scope, ownership and recorded-identity guards. Expose these runs in Tasks without tying their lifetime to the side panel.

**Tech Stack:** Rust host/service, generated native-message protocol, TypeScript Chrome extension and offline fake-harness tests.

**Sources:** `extension/capture-site-panel.ts`, `extension/task-history.ts`, `extension/run-card.ts`, `host/src/capture_site.rs`, `host/src/service/{prompt,record,finisher,supervisor}.rs`, `docs/agents/safety.md` and DESIGN.md §4–5.

## Design challenge

- **Challenger:** Parallel design reviewer in this session.
- **Alternative:** Reuse the site-draft lifecycle and host-owned apply rather than start an ordinary task that edits configuration itself.
- **Outcome:** Adopted. This retains per-origin deduplication, persistence, cancellation, checked answers and configuration authority while adding browser observation and Tasks visibility.

## Open decisions

- **Decision:** Run automatically after initial capture setup, including starters and restored rules. **Status:** Resolved by the user request, 2026-11-23. **Default if unresolved:** None.
- **Decision:** Browser observation follows bounded, read-only, same-origin links in headless mode; inaccessible sites produce a failed review and retain initial rules. **Status:** Resolved by the requested headless review and existing safety policy. **Default if unresolved:** Fail without applying.
- **Decision:** Preserve existing user scope/title choices and refuse stale revisions or identity changes. **Status:** Resolved by repository safety invariants. **Default if unresolved:** Fail without applying.
- **Decision:** Keep scope choices when initial rules require explicit account consent; never infer every-account acknowledgement. **Status:** Resolved by existing scope authority. **Default if unresolved:** Retain the existing scope choice step.

## Tasks

1. Add capture-review protocol context and persist it through the existing site-draft service lifecycle. Owner: service lane.
2. Add a headless review prompt and host-owned result validation/publication. Owners: service lane and coordinator.
3. Launch the durable review after capture, show compact progress and expose its details in Tasks. Owner: extension lane.
4. Cover successful, blocked, stale, unsafe, close/navigation and restore/starter flows with offline tests. Owners: corresponding lanes.
5. Update product contracts, run the applicable gate and review, then publish through the repository PR/deploy workflow. Owner: coordinator.

## Validation

Use synthetic URLs, temporary configuration and fake harnesses only. Check protocol generation, focused Rust capture/service tests, built extension tests, document checks, privacy scan and the README gate subject to the documented load limit. Keep local validation, CI, merge, deployment and Chrome-loaded evidence distinct.
