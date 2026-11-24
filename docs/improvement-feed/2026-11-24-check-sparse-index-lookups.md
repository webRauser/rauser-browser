## 2026-11-24 — Check sparse index lookups

Change: Add rare-hit, missing-key and repeated-hit fixtures when a new native lookup must find evidence in a growing cache.
Why: A response limit still allowed SQLite to decode every checked body for a rare or missing target in the design challenge. A raw input limit missed an old valid positive.
Where: SQLite query regression tests and the design challenge checklist for new index views.
