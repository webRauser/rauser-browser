## 2026-11-24 — Verify shared Stash reading state in the browser

Add a repeatable smoke fixture that opens two ordinary Chrome profiles with the same temporary Stash home. After one profile completes an item and the other moves it back to To read, verify that both display the same state, the first Done receipt is intact, and a stale Undo receives a conflict.
