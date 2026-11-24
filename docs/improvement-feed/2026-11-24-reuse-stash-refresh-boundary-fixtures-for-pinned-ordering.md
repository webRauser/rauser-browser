## 2026-11-24 — Reuse Stash refresh boundary fixtures for pinned ordering

Exercise saved items crossing an exact page boundary when Pin changes the result order. Include a new save, an item leaving the filter and two save times in the same millisecond. The first queue review needed separate fixes for a displaced tail and one that legitimately disappeared. The Stash browser suite now has fixtures for both. Reuse them for pinned-first paging before the first full CI run. [Stash roadmap](../history/2026-11-24-stash-design-review.md#roadmap-execution)
