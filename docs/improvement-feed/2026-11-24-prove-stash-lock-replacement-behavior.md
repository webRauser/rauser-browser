## 2026-11-24 — Prove Stash writes across lock replacement

Exercise two native writers with a request paused while it holds the original configuration lock. Replace that lock path in a temporary fixture, then verify the stale request receives no successful mutation acknowledgement and existing record bytes survive. This covers a different interval from replacing the lock between requests.

- +1 2026-11-24: Add the held-lock replay to the opt-in native compatibility suite, including a pause after staging and before the final name is published. The synthetic replay reproduced stale Pin acknowledgements and writes after home reselection.
