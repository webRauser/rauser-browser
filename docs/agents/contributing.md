# Contributor workflow

Read [AGENTS.md](../../AGENTS.md) for repository boundaries and mandatory safeguards.
This guide supplies task-specific procedures; commands in [worker-contract.json](../../worker-contract.json), their `--help`, and checked-in configuration are authoritative over duplicated prose.

## Plan and coordinate

Use [docs/superpowers/README.md](../superpowers/README.md) for plan structure, the required design challenge, open decisions, and guard-invariant tests.
Resolve decisions before starting dependent work.
Land large shared-code rewrites as small, independently green changes: mechanical prerequisites first, then an abstraction with the replacement disabled until validated, then activation and removal separately.
Group small related changes when they share validation; avoid unrelated work in the same PR.

For parallel lanes, use the [lane brief](lane-brief-template.md) and record ownership, worktree, branch, bead, head SHA, and completion state.
Run `scripts/dev/overlap-check <paths>` before editing and `scripts/dev/overlap-check --branch` before opening the PR.
Read source-unavailable warnings as incomplete coverage, not evidence of no overlap.
Use `scripts/dev/who-owns <pr|bead|worktree|branch>` to find an existing owner; the coordinator reassigns abandoned work before another session pushes to its branch.

## Work queue

Beads live in bd's Dolt database, synchronized through `refs/dolt/data`; linked worktrees share the main checkout's database.
Do not edit the database through exported files or commit `.beads/issues.jsonl` or `BOSUN_FEATURE_BACKLOG.md`.

```sh
scripts/dev/queue bootstrap         # once in a fresh clone
scripts/dev/queue backlog --print   # current rendered backlog
scripts/dev/create-bead "Title" -d "Description" --acceptance "Done when…" -t task -p 2
bd update <id> --status in_progress
scripts/dev/queue sync              # after bd edits
scripts/dev/queue doctor            # diagnose bootstrap or sync trouble
```

`create-bead` pulls, creates, and synchronizes; an unsuccessful final sync can leave the bead created locally.
Use bd for updates, dependency changes, labels, and closure, followed by `queue sync`.
`queue export` prints JSONL for readers; `queue backlog` writes a disposable rendered view under `target/queue/`.
The view combines beads with [docs/backlog/frame.md](../backlog/frame.md) and individual notes under `docs/backlog/notes/`.
Edit that prose in normal PRs, outside generated blocks; open work belongs in beads.
Placement and shipped-summary metadata are interpreted by [scripts/render_backlog.py](../../scripts/render_backlog.py), and `queue check` validates them against the frame.

Interpret sync status using `queue.sync_exit_codes` in the worker contract and the actual diagnostic.
Exit 1 does **not** guarantee nothing was published: a consistency check after a successful bd push can report `synced, but edits pulled during the push fail the check`.
Exit 2 requires conflict resolution, 3 permits a later retry, and 4 requires an operator to clear a stuck working set.
Run the read-only doctor before repair; do not seed a populated remote or replace a database from an export.
Specialist recovery commands (`adopt`, `seed`) and worker workspace routing are documented in [scripts/work_queue.py](../../scripts/work_queue.py) and its CLI help.

Close a bead only after its change is on `origin/main`, naming the merged PR or main commit and any required acceptance evidence.
Keep unmerged work `in_progress` with its commit and remaining steps.
A green skipped job proves nothing; name the job, run ID, and commit that actually passed.
Reserve `[human]` for checks an available agent cannot perform, after checking existing CI and [TESTING.md](../../TESTING.md) evidence.

## Validate and review

Use the [README development gate](../../README.md#development) and [TESTING.md](../../TESTING.md) for commands and coverage limits.
Run focused checks while implementing, then the applicable complete gate once before review; repeat affected checks after fixes or merges.
Docs-only edits need the contributor-document checks and checks for any tooling they change, rather than application builds.
For an adapter/starter-only change, `npm run gate:adapter` is the local gate; if it rejects the scope, use the README gate.
After changing either adapter-template engine, run `npm run test:adapter-diff`.
Run `cargo deny check --all-features --locked` for Rust dependency changes.

Check load before a full local suite (`uptime`, and `sysctl -n hw.ncpu` on macOS).
Above twice the core count, run focused checks and leave the full suite to CI, recording the observed load and omitted checks in the PR.
Rerun a timed-out module alone and report both results; do not share another worktree's `CARGO_TARGET_DIR`.
Use the headless smoke recipe by default; real-dialog UI checks require the user's request and advance notice that they take focus.

Run one `codex exec review --base origin/main` pass on the pushed head alongside CI, after local validation.
Fix P1 findings with regression coverage; file P2/P3 findings as beads unless the fix is a few lines without a new test seam.
A second pass is justified when P1 fixes substantially change behavior; avoid repeated review cycles without new evidence.

## Publish, watch, and hand off

Create the PR body from [.github/pull_request_template.md](../../.github/pull_request_template.md), filling in owner session, coordinator, overlap, validation, and recoverable handoff state.
Check it with `node scripts/pr-owner.mjs --body-file <file>`, then use the file when creating or updating the PR.
Scan proposed PR text or a commit message with `node scripts/privacy-scan.mjs --message <file>` before publishing it.

After the final push, use the contract's merge command:

```sh
node scripts/dev/queue-pr.mjs <pr> --head <sha>
node scripts/dev/pr-watch.mjs <pr> --until merged
```

Run the queue helper again after a later push; it waits for GitHub to show that head and handles labels, queue requests, and stale-status refreshes idempotently.
Do not substitute a raw merge command or treat green checks as proof of a queue entry.
Follow each actionable watcher exit, then resume watching; handoffs name the PR, head, last watcher result, and remaining action.
Merge main only for a real conflict the PR doctor cannot repair, then rerun affected checks and requeue.
Automation details belong in [PR fixer](pr-fixer.md) and the doctor/keeper scripts, rather than a second manual repair loop.

CI definitions live in [.github/workflows/ci.yml](../../.github/workflows/ci.yml) and [build-os.yml](../../.github/workflows/build-os.yml); merge requirements live in [.mergify.yml](../../.mergify.yml).
Code PRs and queue drafts run Windows plus Linux checks; macOS builds and headless smoke run after pushes to main, with a fallback only for runner starvation.
Docs-only PRs take the docs-check path; the privacy scan still runs.
Use main's actual post-merge macOS result where acceptance requires it, and fix failures forward.

Deploy from the main checkout using the existing [README runbook](../../README.md#development) and `scripts/dev/deploy-live --help`.
Keep CI-green source, published host, rebuilt extension, and Chrome-loaded extension state distinct when reporting the SHA and observation time.
Clean finished worktrees through `scripts/dev/worktree-hygiene`, inspecting its default dry run before applying removal.

## Author docs and generated sources

Update [DESIGN.md](../../DESIGN.md) for changed contracts, [TESTING.md](../../TESTING.md) for validation guidance, and [current-state.md](current-state.md) through its row sources under `docs/agents/current-state/` and `npm run gen:current-state`.
Add dated implementation history and test records through the split-log contracts in [docs/history.md](../history.md) and TESTING.md; keep historical narratives out of AGENTS.md.
Use one sentence per line in instruction Markdown.
Edit protocol schemas and starter source families, then regenerate; do not hand-edit generated outputs.
`scripts/dev/setup-merge-drivers` installs the optional generator-aware merge driver; resolve untrusted generator changes by hand, and never give generators credentials.
App prompts such as root `SUMMARY.md` are shipped product code, separate from contributor guidance; new compiled root Markdown must be included in `BUILT_ROOT_MARKDOWN` in `scripts/ci-changes.mjs`.
Put Brauser improvement suggestions in its [own feed](../../BRAUSER_IMPROVEMENT_FEED.md).

## Add a starter

Research actual URLs and tab titles first, following [the starter design's research method](../superpowers/specs/2026-11-03-starter-families-design.md).
Run `npm run new:starter -- <family> <type> [--exact <origin> | --subdomain <suffix>] [--scope <kind>]`, fill every reported placeholder, then run `npm run gen:starters` and `npm run gate:adapter`.
Follow [protocol/starters/README.md](../../protocol/starters/README.md) for vectors, overlaps, scope kinds, and frozen IDs.
A scaffold starts with `development` status; claim `live` or `history` certification only after examining that evidence.
