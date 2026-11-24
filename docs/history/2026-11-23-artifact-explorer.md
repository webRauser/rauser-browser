## 2026-11-23 — Artifact Explorer opens from the sidebar

DESIGN.md section 5.5 now defines Artifact Explorer as a full web page opened in the browser's main area from a sidebar action.
The bundled page reuses an existing Explorer tab and reads the selected local library through native messaging, without a server, new permission or agent run.

The first implementation uses existing indexed artifacts and saved-summary metadata: unique canonical rows, latest summaries across days, text search, source/type/category/reading filters and complete-library facet counts.
The inspector and focused connection map explain recorded containment, title mentions and navigation separately from exact saved-category associations.
Existing categories are read-only; full-text search and richer subject/entity/tag projections remain separate work.

Read requests bind the configuration revision, picked-folder identity and full-result page snapshot.
An optional revision on the existing saved-summary opener prevents an old preview from opening a same-named file in a newly selected home folder; legacy callers retain their omission behavior.
Filter changes and newer metadata cannot silently leave the inspector on an unrelated item.
Bounded presentation preserves stored data, while invalid authority fields refuse rather than being truncated into different identities or addresses.

The implementation adds protocol-v8 requests and no authoritative-record or index-schema migration.
Host and extension must be deployed together; an older host reports that an update is needed.
Synthetic validation and review findings are recorded in the corresponding testing-log entry.
The launch action is retained beside Settings in the simplified sidebar header.
Browser launch failures signal the closed Activity control and expose their explanation in its Notice disclosure.
