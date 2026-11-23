## 2026-11-01 — Cookie stacked PR landing log

This record concerns DESIGN.md §12 (implementation and validation).
It preserves the November 1 landing observations; the private local worktree path is omitted.

### #195 (cycle-5, brwr-f85 bd hydrate)
- Head at checkout: 3785cc7 (remote unchanged at push).
- Labeled `final-stretch`.
- Merge origin/main (25fd521): conflict in BOSUN_FEATURE_BACKLOG.md; .beads/issues.jsonl auto-merged. Resolved with `render_backlog.py --resolve`. Merge commit 149d846.
- Test fix: reproduced locally on macOS (2 failures, /var vs /private/var). Fix in b85b727: `self.root = pathlib.Path(self.tmp.name).resolve()` in scripts/tests/test_create_bead.py (production resolves root intentionally; unchanged).
- Local checks: test:queue OK, check_queue_consistency OK (43 live), test:scripts 58/58, python scripts/tests all OK.
- CI round 1 (run 41364063334): Windows passed (path fix confirmed); macOS smoke failed "The recognized page's artifact lost its activity" after 00:00 UTC. Rerun failed identically (deterministic, not flaky). Cause: list_artifacts returns one row per local day; the page's visit row was 2026-11-01 and the summary row 2026-11-02, and the smoke used `items.find(url)` (first row = summary row, opens 0). Note: visits were dated 11-01 (browser-local) while summarized_at was `...Z` on 11-02, so the summary day appears to follow UTC rather than the user's offset; possible product timezone issue, flagged, not changed.
- Smoke fix ecbbf08 (scripts/smoke-macos.mjs): accept the page's activity on any day's row for that URL.
- CI round 2: all green. Merged by auto-merge/queue: ba4f6c597d14c79624ea085c5211ae7c92ea79c5. `final-stretch` removed.

### #196 (cycle-6)
- Head at checkout: e905089 (remote unchanged at push). Labeled `final-stretch`.
- Merge origin/main: clean, no conflicts (merge driver handled .beads/backlog). Merge commit ff07ec2. `render_backlog.py --check` OK.
- Local checks: test:queue OK, check_queue_consistency OK (42 live), test:scripts 73/73, python scripts/tests OK.
- CI: all green first try. Merged: fa87202310564143c20d4a7f4bf551d87421f148. `final-stretch` removed.

### #197 (cycle-7)
- Head at checkout: d5a156b (remote unchanged at push). Labeled `final-stretch`.
- Merge origin/main: clean, no conflicts. Merge commit e860fa6. `render_backlog.py --check` OK.
- Local checks: test:queue OK (37 live), test:scripts 73/73, typecheck OK, eslint on touched files OK, build:extension OK, task-tracker + panel/task-bar tests 50/50.
- CI: all green first try. Merged: d8d228cadb3cdd312c2d46793e3a5c34eb11dea6. `final-stretch` removed.

### #199 (cycle-8)
- Head at checkout: 405b6ef (remote unchanged at push). Labeled `final-stretch`.
- Merge origin/main (incl. #204 Office-doc content): textually clean, merge commit 4ce4cc4. `render_backlog.py --check` OK.
- Semantic conflict: main's #204 added an `office_document: bool` argument to `summary_prompt`; this PR's new test `a_resumed_queued_run_keeps_its_recorded_vocabulary` (host/src/service/supervisor.rs) called the 3-arg form, so the lib test failed to compile (E0061). Fixed in 8df7921 by passing `false` (seeded record is an example.com page). Both intents kept.
- Local checks: test:queue OK (38 live), test:scripts 73/73, cargo fmt --check OK, clippy --all-targets -D warnings OK, cargo test service:: 357 passed.
- CI: all green. Merged: 63998d349fa9b5dcd11469a152c2241fb3821669. `final-stretch` removed.

### #200 (cycle-9)
- Head at checkout: 127cc5e (remote unchanged at push). Labeled `final-stretch`.
- Merge origin/main: clean, no conflicts. Merge commit 696d929. `render_backlog.py --check` OK.
- Local checks: test:queue OK (31 live), test:scripts 73/73, protocol/generate.py --check OK, typecheck OK, eslint touched files OK, build:extension OK, tasks-page + run-card tests 80/80, cargo fmt --all --check OK, clippy --workspace --all-targets -D warnings OK, protocol crate tests OK.
- CI: all green first try. Merged: 7122055376f3e43ad58f18326f0975d2b2dc6bcf. `final-stretch` removed.

### Follow-up for coordinator
- Possible product timezone bug (not changed): on the macOS runner, the page's visits were filed under browser-local day 2026-11-01 while the summary event's `summarized_at` was `2026-11-02T00:11:29Z` (UTC). `finisher::summarized_at` takes its offset from the run's `requested_at`, and the extension sends `localTimestamp` with a local offset, so a `Z` there suggests the offset gets lost somewhere between the extension and the service record. For users west of UTC, an evening summary may be filed under the next day.
