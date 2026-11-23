**Known issues come before plan work (set by John, 2026-10-16).** While any
item under "Known Issues (Blocking Deploy)" is unchecked, take the first one
before any plan item. Fix it with a regression test, check it off with a
one-line note, and keep each fix to one cycle. These came from a code review
of PR #34 (merged to GitHub main as 68f180b). The review was not separately
verified, so confirm each failure scenario with a failing test first. If the
test shows the finding is wrong, check it off as "not reproduced" and say why.

## Known Issues (Blocking Deploy)

- [ ] **Adapter removal refused when two adapters share origin and type.**
  `validate_adapter_transition` (host/src/config.rs ~1254) checks each old
  adapter against a surviving sibling's id. Two `work.issue` adapters on one
  origin (`/issues` id X, `/tickets` id Y): removing the second fails with a
  misleading "id template ... cannot change" error. The same happens when
  `adaptersForSites` drops only one of the pair.
- [ ] **The id-template freeze can be bypassed** (host/src/config.rs ~1234).
  Removals are never checked and identity is (origin, type). So you can remove
  `jira.issue` and later re-add it with a new id, or change type and id in one
  edit, and either way existing artifact records are orphaned. That
  contradicts the doc comment's "impossible for a config edit to orphan
  activity". Decide the intended rule (for example, remember retired ids per
  origin), then enforce it.
- [ ] **No repair path while `adapter_issue` is set** (host/src/consent.rs
  ~336, extension/options.ts ~161 and ~517). Every write that echoes the stored
  adapter document fails full `validate()`. That includes harness setup,
  denylist, and folder changes, and the UI disables every adapter control and
  refuses format != 1. This breaks the "notes and AI settings remain usable
  during adapter repair" contract. Non-adapter writes must succeed, and the UI
  needs a way to replace or remove the bad document.
- [ ] **Adapter editor keys on a stale array index** (extension/options.ts
  ~528). If another tab or a lease change reloads `session.config` while the
  editor is open, Save overwrites whatever adapter now sits at that index, with
  no confirmation and no revision conflict. Key the edit by adapter identity
  and refuse the save if the target changed.
- [ ] **Removing an adapter or site re-confirms every later adapter**
  (host/src/consent.rs ~808, `approval_lines`). An index shift reads as a
  policy change, so revoking one site asks for "Enable or change ..." plus the
  every-account disclosure for each later unscoped adapter. With ~29 or more
  unscoped adapters it passes the 8192-byte cap and refuses the removal. That
  contradicts DESIGN "Removing or narrowing them takes effect immediately".
  Compare by identity, not index.
- [ ] **Invalid adapter policy discards recognized visits for good**
  (host/src/native.rs ~534). `adapter_policy_invalid` returns terminal
  Suppressed, while `config_issue` returns retryable. Visits recognized under
  a valid lease are lost during a transient fault. Make it retryable.
- [ ] **Chrome revocations not written back while `adapter_issue` is set**
  (extension/settings.ts ~317; `removeSite` in options.ts).
  `reconcileRevocations` throws, so the host keeps a revoked origin
  allowlisted. Revocations must always narrow host policy.
- [ ] **Full adapter compile on every navigation** (extension/model.ts ~153).
  `isPolicyLease` runs `validateDocument` on every `readPolicy`, including the
  never-enabled-site fast path, and `matchingArtifact` stringifies the document
  for its cache key on every call. Validate once at install and cache by
  revision.
- [ ] **Quadratic overlap scan on every host refresh** (host/src/config.rs
  ~950, ~1226). `read_disk_state` computes `overlap_report` on every Hello,
  GetConfig, LoadNote, SaveNote, and RecordVisit, and `adapter_matches`
  recompiles. Compute warnings only for GetConfig and post-commit, and reuse
  one compiled Document per revision.
- [ ] **AGENTS.md "Current state" is stale.** It says the worker lease, the
  TypeScript prefilter, and host recognition are unbuilt, but they shipped.
  Update it to match README.md and DESIGN.md.
- [ ] Smaller ones from the same review:
  - In `setStarterButtonState` (options.ts), `offer?.adapter !== null` is true
    when `offer` is null.
  - `hasAdapter` (starter-adapters.ts) can't see an existing GitHub adapter
    until an org scope is typed.
  - `StoredAdapters` uses `deny_unknown_fields`, so a newer `[adapters]` key
    makes the whole config unreadable (backup-and-rewrite) instead of just
    suspending adapter policy.
- **Standing rule (not a task): keep the smoke runner's dialog count right.**
  When a change adds or removes a scripted dialog or smoke step, update the
  expected count in `scripts/smoke-macos.mjs` in the same commit. The smoke run
  can't execute on this Linux VM, so GitHub CI's macOS job
  (`npm run smoke:macos:headless`) is the only place it runs. Note the expected
  count in the cycle summary. GitHub main (68f180b) was merged into this
  workspace on 2026-10-16 and brought in the count fix (14) and the gitignored
  `.last_cycle_review_output.md`.
