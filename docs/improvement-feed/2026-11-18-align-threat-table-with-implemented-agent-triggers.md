## 2026-11-18 — Align the threat table with implemented agent triggers

Change: Update DESIGN.md §4.1's prompt-injection and sensitive-page rows to cover manual summaries, configured automatic summaries, tasks and site drafting, using the detailed §4.5 and compiled prompts as evidence.
Why: The contributor-instruction review found that those rows still say an agent runs only when the user requests a summary on one page, while automatic summaries and task runs are implemented.
Where: DESIGN.md §4.1, checked against `extension/auto-summary.ts`, `host/src/service/prompt.rs`, `SUMMARY.md` and the corresponding TESTING.md sections.
