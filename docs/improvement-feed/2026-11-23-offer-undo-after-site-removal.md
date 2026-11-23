## 2026-11-23 — Offer Undo after site removal

Change: Offer an Undo action after removing a captured site, using the host's recorded-rule restore flow and preserving the current capture pause.
Why: Removal keeps saved notes, summaries and history, but restoring a mistaken removal currently requires reopening Capture Site and reviewing the recorded rules.
Where: `extension/capture-site-panel.ts` and the existing `get_site_restore` review flow.
