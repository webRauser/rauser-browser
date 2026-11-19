# Contributor instruction review — 2026-11-18

Reviewed `AGENTS.md` at `ca68178f818f600743fdf8827f05a7cff323a8ff` against the checked-in implementation, workflows, worker contract and owning documentation.
Three independent audits covered architecture/status, contributor workflow, and security/compatibility.
The original was 592 lines, 14,134 words and 95,770 bytes.
The condensed root is 118 lines, 1,219 words and 9,211 bytes: 91% fewer words and 90% fewer bytes.
Its main problem was mixing stable instructions with a generated product inventory, implementation walkthroughs, repeated runbooks and dated incident narratives.

## Incorrect, ambiguous or conflicting guidance

Original line references below refer to the reviewed commit, not the condensed file.

| Original guidance | Evidence and disposition |
|---|---|
| Every PR pays for a macOS run; draft pushes exercise both platforms (lines 433, 453) | `ci.yml` restricts macOS to pushes to main; PRs and queue drafts use Windows/Linux checks. Removed historical timing/cost arguments and described current routing in `contributing.md`. |
| A queue-sync exit 1 means nothing pushed (line 264) | `scripts/work_queue.py` can fail a late consistency check after successful `bd sync`. The workflow guide now requires reading the diagnostic and preserves the possibility of publication. |
| The release app registers itself (line 141) | `host/src/main.rs` starts the native host on no arguments; TESTING.md's packaging section explicitly lists registration on open as unbuilt. Removed the false repository-map claim; the status page retains the gap. |
| Public and private repository assumptions (lines 214, 377–378) | The file contradicted itself; live repository metadata returned PUBLIC during review. Removed visibility-dependent policy and historical protection assumptions; synthetic fixtures remain mandatory. |
| Only Office-specific text authorizes retrieval (line 571) | `SUMMARY.md` permits retrieving the single Source artifact for incomplete captures and also has Miro guidance. Safety guidance now follows the compiled prompt's scope. |
| `agent.env` wording implies the file is required (line 583) | `host/src/service/agent_env.rs` treats absence as an empty overlay. The file is explicitly optional; its checks remain strict when present. |
| Rollback rule covers active tasks only (line 46) | DESIGN.md's capped-capture and incoming-snapshot compatibility notes require no active runs across incompatible record changes. The safety guide covers all queued/running runs. |
| Artifact replacement lives in `host/src/index.rs` (line 531) | That file no longer exists; the implementation is `host/src/index/regen.rs`. Corrected the pointer. |
| Signing secrets remain unset; signed apps and publication are categorically unbuilt (generated status rows) | Source code cannot establish current secret configuration or release history. Retained implementation status and made signing/publication readiness require separate evidence. |
| Manual label/comment timing is the contributor queue recipe (lines 257–259, 359–363) | `worker-contract.json` names the idempotent `queue-pr.mjs` helper. The guides use that helper and `pr-watch.mjs`, without duplicating their parsers or repair logic. |

## Condensation decisions

- Keep project boundaries, task routing, source-of-truth pointers, isolation, essential validation, merge ownership and core trust/file safeguards in root `AGENTS.md`.
- Move the generated table to [current-state.md](current-state.md), preserving row sources and generated validation.
- Put task-specific queue, review, CI and starter guidance in [contributing.md](contributing.md); link existing README and script runbooks instead of copying deployment internals.
- Put cross-component capture, identity, filesystem, harness, service and rollback invariants in [safety.md](safety.md), with code/test pointers.
- Remove historical PR timelines, runtime/cost measurements, retired holds, shell tips, exhaustive symbol/test lists and repeated plan/feed rules.
  Git preserves the original; it does not need another instruction archive loaded by agents.
- Preserve existing root headings used by active templates where practical; update the fixer prompt, lane template and README where their routing changed.

## Design challenge

Keeping the generated table in the root would make the patch smaller but keep loading volatile product status for every task.
Deleting it outright would break generation, stale-status validation and generator-aware merges.
The selected approach moves the table and all those consumers together; focused tests cover LF/CRLF generation, preservation of root instructions, clean two-branch status merges and real handwritten conflicts.
Detailed safety guidance remains an explicit prerequisite for the changes it governs.

## Validation and limits

Run `python3 scripts/check_current_state.py`, `npm run test:scripts`, `npm run test:dev-tools`, `npm run lint`, the privacy scan, and local link/anchor checks for the revised instruction set.
Application behavior and runtime binaries do not change; no application deployment is required.
Check the PR for final results rather than treating this command list as a passing receipt.
The `orca-cli` skill successfully created the isolated worktree; no skill change was identified in this run.

The review also found stale requested-summary-only assertions in DESIGN.md's threat table (§4.1), despite implemented auto-summary and task runs.
That separate design correction is recorded in the improvement feed; the new safety guide describes the implemented run modes.
