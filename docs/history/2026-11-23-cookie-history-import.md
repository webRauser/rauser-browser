## 2026-11-23 — Retain Cookie's historical backlog and landing records

This record concerns DESIGN.md §12 (implementation and validation).
The [October 16 source archive](cookie-2026-10-16/README.md) retains the known-issues and proposed-reseed snapshots as two byte-identical historical revisions.
Their old priorities and unchecked tasks do not establish current product status.
The [November 1 stack landing record](2026-11-01-cookie-stack-landing.md) retains the PR chronology, fixes, validation observations and unresolved timezone concern.
Its heading levels follow the split-log format, and its local machine path is omitted; the original is retained privately for the organization handoff.

The reviewed landing destination was absent in the local source and available Git history at import time, so this change creates it without replacing an existing record.
The split-log checker permits only the named source archive with its three expected regular Markdown files.
Other history directories remain invalid, the testing log and improvement feed retain their existing layout rules, and the combined history view includes the dated records without duplicating archive contents.

Original source removal remains an integration gate for the organization coordinator.
The known-issues source also remains an input to a helper and must stay there until a separate reviewed helper change removes that dependency.
