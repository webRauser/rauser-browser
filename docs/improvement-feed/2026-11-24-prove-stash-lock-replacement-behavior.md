## 2026-11-24 — Prove Stash writes across lock replacement

Exercise two native writers with a request paused while it holds the original configuration lock. Replace that lock path in a temporary fixture, then verify the stale request receives no successful mutation acknowledgement and existing record bytes survive. This covers a different interval from replacing the lock between requests.
