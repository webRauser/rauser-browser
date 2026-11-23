## 2026-11-23 — Retain route coverage in site review reports

Change: Add structured counts for pages observed, route families tested and checks skipped to each automatic capture-review result, and show those counts beside its report in Tasks.
Why: the post-save review can validate safe additive rules or stop at an unavailable browser or login wall, but a free-text report and URL-shape evidence alone do not make incomplete site coverage easy to compare across retries.
Where: `host/src/capture_review.rs`, `host/src/service/prompt.rs`, the capture-review result protocol and `extension/run-card.ts`.
