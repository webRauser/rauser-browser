# Brauser Feature Backlog

This file is read by Cookie's overnight loop. DESIGN.md is the authoritative
spec: read it before starting any item below, follow its decisions (§14) and
security rules (AGENTS.md), and update it yourself when an implementation
choice changes a contract it describes. Do not treat this backlog as a
substitute for DESIGN.md — it exists to keep each cycle's scope bounded, not
to repeat the spec.

**Priority rule (set by John, 2026-10-16): the DESIGN.md §12.2 plan comes
first.** Each cycle, take the first unchecked item under "Plan work" below, in
the order listed, and build it before anything else. Do not ideate, pick, or
start self-proposed items under "Cookie's own proposals" while any plan item
you can complete on this VM remains unchecked. A plan item that needs a human,
real macOS Chrome, or a live work tool is marked **[human]**: skip it, do not
fake its evidence, and move to the next plan item. If a plan step is too big
for one cycle, split it into ordered sub-items here rather than reordering the
plan. You may still add proposals and notes at cycle end — just don't build
them ahead of the plan.

## Known Issues (Blocking Deploy)

- None.

## Proposed

### Plan work (DESIGN.md §12.2, in order)

- [ ] **M1.5a step 6.4 — Measured artifact activity.** Replace the temporary
  visit rows with hourly artifact activity: cold opens, focused and background
  seconds, modes, and trail sources in durable worker totals, frozen into one
  idempotent `activity` event per artifact and local hour, plus `why` events.
  Rebuild the tab map on worker start, and cover the hour boundary, UTC-offset
  change, browser restart with a pending total, idle/lock, discarded tabs,
  reloads, restored sessions, SPA route changes, board-modal switches, and the
  map-rebuild cases listed in §12.2 step 6.4 and §5.1.
- [ ] **M1.5a step 6.5 — Delivery and durability.** One write, one sync, and
  one intent record per delivery batch; the compact intent index replacing
  M1's one-intent-file-per-visit journal; buffer-pressure coalescing, the 80%
  badge, and overflow accounting in the strip and the log. Retire
  `near_repeat_secs` (accepted and ignored in old configs, dropped from the v5
  schema, confirmation line removed). Test two `/log` entries for one URL a
  minute apart, both recorded.
- [ ] **M1.5a step 6.6 — Index tables and artifact files.** `artifacts`,
  `visits`, and `edges` tables in `index.db`; lazy regeneration from the dirty
  set with skip-if-unchanged and Timeline rollups (§6.7); `brauser reindex`
  rebuilding both from the logs. Test a hostile title, a case-colliding ID, an
  external edit being replaced, a heavy-use day producing no file write until
  regeneration, and a year of daily opens staying within rollup bounds.
- [ ] **M1.5a step 6.7 — Panel, Recent, worklog, and record keys.** The
  artifact card (§5.7), the one-liner, the Recent tab (one history across
  tools, grouped by day, type and title filters), and the worklog view with
  Copy, backed by `get_artifact`, `list_artifacts`, and `worklog`. Record keys
  (§6.2) land here and **must ship before any M2 summary write**: `load_note`
  and `save_note` resolve and return the key, and older URL-keyed notes are
  listed. Cover every test case named in §12.2 step 6.7.
- [ ] **[human] M1.5a step 6.8 — Certify the three starter adapters.** Check
  the Jira, SharePoint/OneDrive, and GitHub drafts against each live tool and
  record the date in `docs/adapters/`. Needs John on macOS with real accounts;
  Cookie must not change the "development draft" label or mark 6.8 done.
- [ ] **§12.2 step 2 — Headless page-load check in CI (optional,
  recommended).** Load the built `extension/dist/` in headless Chrome and open
  the panel and settings page, so a stale-manifest class of failure is caught
  before a manual run.
- [ ] **M2 step 8.2 — Host invocation.** Start only after 6.4–6.7 are shipped.
  Allowlisted environment, templated argv, page content on stdin inside the
  untrusted-data block, host-owned working directory, timeout, output cap,
  process-tree kill, and the confirmed-install-location check (§7.1), with the
  fake-harness tests and the §7.1 canary listed in step 8.2.
- [ ] **M2 step 8.3 — Streaming protocol.** A reader that stays responsive
  while a harness runs; chunk, `rejected`, error, `cancel`, and
  `summary_result` messages correlated by `request_id` under the 900 KiB cap;
  stdin EOF kills the harness. Takes the next protocol version after v5.
- [ ] **M2 step 8.4 — Content extraction.** Bundled, pinned Readability-style
  extraction, the `summarize` command, context menu, and toolbar trigger, and
  the §8 permissions. **[human]** sub-step first: the real-Chrome `activeTab`
  checks (a)–(d) in step 8.4 need macOS; build the rest behind them only once
  they are recorded.
- [ ] **M2 step 8.5 — `/summarize` in the panel.** Denylist checks, the §5.2
  and §4.4 summary write and result contract, the §3.1 extension-page CSP with
  a manifest test, and the external-editor race, shared summaries directory,
  and mid-run config-change tests.

### Gated plan work (do not start yet)

- **M1.5b (§12.2 step 7.1–7.7)** — aliases, Tier 1 fields (`scripting`),
  worklog files, the remaining starter adapters, Create adapter with the
  structural drafter, then agent drafting. DESIGN.md gates this on M1.5a being
  in daily use for a few weeks; John will lift the gate here when it's time.
- **M3 — Related** (FTS5 in `brauser reindex`, related pages, read later),
  **M4 — Omnibar** (built-in commands, free text, custom commands), and
  **M5 — Release** (installer, store listing, signing and provenance, docs)
  follow M2, per the §12 table. M5 signing and store work is **[human]**.

### Cookie's own proposals (only after the plan work above)

- [ ] **Make first-tool setup one coherent transaction.** Let a new user choose
  Jira, SharePoint/OneDrive, or GitHub first, enter the exact tenant and any
  required scope, then request Chrome access and native-confirm the site plus
  starter together. Roll back a newly acquired grant on cancel and retain it
  when notes or another site purpose already needs it. This removes today's
  confusing intermediate state where a site is enabled but records nothing
  until a second adapter save and confirmation.

## In Progress / This Iteration

- None.
