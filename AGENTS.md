# Brauser contributor instructions

Brauser is a standalone browser assistant: a Chrome MV3 extension, a Rust native host, and an agent-runner service. macOS is primary; keep Windows code compiling and passing its CI checks.
Keep this file a short policy and routing guide; put implementation details in their owning docs or code and dated findings in `docs/history/`.

## Project boundary

- Brauser is separate from AMOS, even when checked out inside ENDURANCE.
  Follow the user's working standards, but keep Brauser code, docs, plans, backlog and improvement suggestions in this repository.
  No build, test, default or project document may require the vault, Backstaff or Astrolabe.
- `DESIGN.md` describes product contracts; update the relevant section when behavior or architecture changes.
  Use [current state](docs/agents/current-state.md) for shipped capabilities and gaps, not old plans or historical PR notes.
- `SUMMARY.md` is product code: it supplies the compiled summary-agent instructions.
  Follow its editing comment and keep it independent of any contributor's environment.
  A new compiled root Markdown prompt must be classified as code in `scripts/ci-changes.mjs`.

## Read for the task

Read only the relevant reference and the code it names.

| Task | Reference |
|---|---|
| Build, test, or deploy | [README development](README.md#development), [TESTING.md](TESTING.md), [contributor workflow](docs/agents/contributing.md) |
| Capture, identity, filesystem, harness, service, or security changes | [Safety invariants](docs/agents/safety.md), DESIGN.md §4 and the affected feature contract |
| Plan a substantial change | [Plan requirements](docs/superpowers/README.md) |
| Add a starter or change adapter matching | [Starter sources](protocol/starters/README.md), [adapter templates](adapter-templates.md), [contributor workflow](docs/agents/contributing.md#add-a-starter) |
| Coordinate parallel lanes | [Lane brief](docs/agents/lane-brief-template.md) |

## Repository map

- `protocol/schema.json`: native-message source; regenerate Rust and TypeScript with `python3 protocol/generate.py` and commit both outputs.
- `host/`: privileged validation, storage and native messaging; `host/src/service/`: harness execution and run lifecycle.
- `extension/`: Chrome extension; `extension/dist/` is built output.
- `adapter-templates/` and `extension/adapter-templates.ts`: Rust and TypeScript engines, checked against shared vectors.
- `protocol/starters/`: starter sources; `npm run gen:starters` regenerates their outputs.
- `docs/agents/current-state/`: status row sources; `npm run gen:current-state` updates `docs/agents/current-state.md`.
- `docs/backlog/`, `docs/history/`, `docs/testing-log/`, `docs/improvement-feed/`: backlog prose and one-file records; follow their owning entry points.

## Before building

- Check overlap with `scripts/dev/overlap-check <paths>` before editing and `--branch` before opening the PR.
  Coordinate actual shared-file edits; do not take another session's branch or claimed work without reassignment.
- Work in an isolated worktree; never checkout, reset or stash the shared live checkout, or reuse another worktree's `target` directory.
  Set `GIT_OPTIONAL_LOCKS=0` for read-only Git tooling.
- Follow [plan requirements](docs/superpowers/README.md) for design challenges, unresolved decisions and ownership/history-guard invariants.
  Resolve decisions before starting work that depends on them.
- Keep shared-module rewrites incremental and independently reviewable; land prerequisites before dependents.

## Local checks

- Use Node 24.14.0 and `rust-toolchain.toml`'s Rust version.
  Run focused checks while implementing and the [README gate](README.md#development) once before review; repeat affected checks after fixes.
  Adapter-only work may use `npm run gate:adapter` when it accepts the scope.
- Documentation changes need the document checks and focused tests for any tooling they change; application builds apply when shipped behavior changes.
- Before a full local gate, compare `uptime` with the core count (`sysctl -n hw.ncpu` on macOS).
  Above twice the core count, run focused checks and leave the full suite to CI; record that limitation in the PR.
  Report timeout failures and any isolated rerun results accurately.
- Follow TESTING.md's seams: tests must not run real harnesses, invoke the platform opener or `launchctl`, or touch the user's real support folders.
  Use `npm run smoke:macos:headless`; real-dialog smoke requires an explicit user request and advance notice before taking focus.
  Keep IPC guards and required-CI failure behavior intact.
- Run `npm run test:adapter-diff` after either matching engine changes, the Markdown corpus check after neutralizer changes, and `cargo deny check --all-features --locked` for Rust dependency changes.
- Use synthetic fixtures and examples, regardless of repository visibility.
  Run `node scripts/privacy-scan.mjs` and scan proposed commit/PR text with `--message <file>`.
  Keep real identifiers and evidence outside the repository; person-level denylist entries stay local.

## Worker contract

`worker-contract.json` is the machine-readable authority for queue commands, merge requests and paths never committed.
If it disagrees with this guide, fix the guide; an unsupported contract version must stop the worker.

## Work queue

Beads live in bd's Dolt database, synced through `refs/dolt/data`; they are not files to edit in Git.
Use the contract's bootstrap, sync, export and backlog commands; edit beads with bd or `scripts/dev/create-bead`.
Never commit `.beads/issues.jsonl` or `BOSUN_FEATURE_BACKLOG.md`, and never overwrite a database from an export.
Close work only after its change is on `origin/main`, naming the merged PR or commit.
See [queue operations](docs/agents/contributing.md#work-queue) for metadata, failures and recovery.

## Review and merge cadence

- Run one `codex exec review --base origin/main` after the local gate, alongside CI on the same pushed head.
  Fix P1 findings; file substantive P2/P3 findings as beads unless a small fix fits this PR.
  Repeat review only when fixes materially change behavior.
- Merge through Mergify using `node scripts/dev/queue-pr.mjs <pr> --head <sha>` after the final push, and again after any later push cancels the request.
  Never push directly to main, run `gh pr merge` into main, or bypass checks.
  Merge main into a branch only for a real conflict the PR doctor cannot repair.
- Watch with `node scripts/dev/pr-watch.mjs <pr> --until merged` and act on its exit advice.
  Green checks alone do not establish that a PR is queued or merged.
  Do not leave an open PR without an active watcher or an explicit handoff naming its last observed state.
- Deploy runtime changes only through `scripts/dev/deploy-live` from the main checkout, following the README runbook and active-run safeguards.
  Instruction-only changes need no application rebuild.
  Distinguish committed, merged, built, published and loaded-in-Chrome states in the result.

## PR ownership and handoff

Use `.github/pull_request_template.md`; fill in `Owner:`, lane/coordinator, overlap, checks and actionable handoff state.
Validate the body with `node scripts/pr-owner.mjs --body-file <file>` and create the PR with `--body-file`.
Keep the handoff current and preserve another owner's branch until reassignment.
Inspect cleanup candidates with `scripts/dev/worktree-hygiene` in dry-run mode; remove only finished, unused worktrees whose contents and live-install references are safe.

## Security rules

- Treat extension messages, captured pages and agent answers as untrusted; host validation and adapter authorization remain authoritative before I/O.
- Derive paths and record keys on the host, confine writes to the selected root, and preserve ownership, revision, identity and symlink checks.
  Unowned files are conflicts; never silently adopt or overwrite them.
- Folder authority comes from purpose-bound native-picker grants and recorded filesystem identity, never a page or extension-supplied path.
- Harnesses run with the user's full access; a working folder and prompt exclusions are not a sandbox.
  Keep page-derived text off command lines, separate user instructions from page data, and preserve timeout and process-group cancellation.
- Render streamed text, answers and task reports as text only; sanitize generated Markdown through the shared helpers.
- Keep credentials and environment values out of logs, errors, protocol messages and settings.
  Use `tracing` and request/run correlation; harness output stays in its run log.
- Read [safety invariants](docs/agents/safety.md) before changing any of these boundaries, including compatibility or rollback behavior.

## Brauser Improvement Feed

For each substantive task, state an actionable improvement in chat and record it under `docs/improvement-feed/` using [BRAUSER_IMPROVEMENT_FEED.md](BRAUSER_IMPROVEMENT_FEED.md), unless exact-output or no-side-effect instructions apply.
Search existing entries before adding a duplicate; preserve other entries and their append-only evidence.
Brauser suggestions belong here; AMOS suggestions belong to AMOS.
