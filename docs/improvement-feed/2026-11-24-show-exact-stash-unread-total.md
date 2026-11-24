## 2026-11-24 — Show the exact Stash unread total

Change: Return an unread total from a bounded host-side Stash query and use it in the sidebar.
Why: The management directory can count the first page of unread entries, but shows 20+ once the host returns a continuation.
Where: The Stash list protocol, host reader, and sidebar directory.
