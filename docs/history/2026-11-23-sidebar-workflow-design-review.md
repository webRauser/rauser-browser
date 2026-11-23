## 2026-11-23 — Simplify the sidebar around page capture and Recent

This review concerns DESIGN.md §5.7 and the workflow from site capture to summaries, notes and enriched Recent.
The former shell put optional focus/task configuration and page-specific controls above the view tabs, doubled several horizontal insets, and allowed expanded activity/capture controls to compete for most of a short panel.
Development copy also occupied routine space, while Recent flattened classification into prose and clipped titles to one line.

The revised shell fixes the header/tabs and composer, lets each view scroll independently, and uses native nonmodal Options/Activity popovers for secondary controls.
Raised cards/actions and inset editors/search share small elevation tokens in both themes, with readable contours and focus indicators.
Recent uses aligned type glyphs, wrapped titles, explicit classification/importance chips and preserved reading-coverage evidence.

| Built feature | Reachable surface |
| --- | --- |
| Capture Site, starter/scope review, restore, draft improvement, validation task/retry | This page capture actions and review |
| Site removal and page-pattern preview | This page → Site options |
| Summary, re-summary, file opening, classification/reading coverage | This page Summary; Recent rows |
| Notes, conflict recovery, older and preserved notes | This page note area |
| Why/context, incoming navigation and contained artifacts | Page card; Recorded navigation |
| Tasks, instruction recall and active-page/folder context | Fixed composer and Tasks link |
| Saved commands, page inclusion, working folder and focus sessions | Options |
| Title/type/reading filters, paging and summary opening | Recent |
| Worklog periods, sharing selection, gap evidence and saved drafts | Recent worklog |
| Notices, run controls, capture delivery/pausing and build identifiers | Activity |
| Setup, permission and update blockers | Visible above the active view |

The inventory distinguishes design intent from current implementation.
Capture Site still begins with the existing review/save choice; persistent validation starts automatically after that save (PR #518).
Related-page search and metadata-wide search remain unbuilt; recorded navigation is observed evidence, and Recent search currently matches titles.
Document labelling beyond existing summary classification is tracked separately and is not claimed by this change.

Validation uses synthetic fixtures rather than corporate pages or a live agent.
See TESTING.md for the browser layout/keyboard seams and the sidebar simplification plan for the native-popover design challenge.
