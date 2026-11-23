## 2026-11-23 — Keep design and implementation-plan status current

Change: Give design specifications and implementation plans a short header naming their current status, owner, resolving PR or commit, and a pointer to any remaining work.
Refresh that header when work is merged, deferred or superseded, while preserving the dated design and implementation evidence below it.

Why: The session review found 860 unchecked boxes across 16 implementation plans, including work whose shipped state is recorded elsewhere.
The open-access, Tasks page and GitHub container specifications still say proposed or draft, and the PR-fixer plan retains a pending-merge handoff for published telemetry work.
Readers must currently reconstruct later history to distinguish unfinished design from completed implementation and outstanding acceptance.

Where: `docs/superpowers/README.md` and the headers of the specifications and implementation plans it governs.
This entry proposes the documentation practice; it does not change plan status or establish completion of the underlying work.
