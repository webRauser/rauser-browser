## 2026-11-23 — Make captured artifact-link coverage inspectable

Change: Show the retained artifact-link count, anchors inspected and a bounded partial/unavailable reason with each captured outbound-link observation, without retaining rejected hrefs.
Why: Planning found that automatic capture currently reads no DOM, summary extraction removes anchor destinations, and document frames or traversal limits can hide links; an empty array alone would conflate missing extraction with a successful scan.
Where: The outbound artifact-link plan in `docs/superpowers/plans/2026-11-23-outbound-artifact-links.md`, the future DOM collector, host observation validation and artifact panel/Markdown rendering.

- +1 2026-11-23: Host foundation proof now distinguishes empty/partial/unavailable, retains the inspected-anchor count and enforces encoded Unicode/escaping bounds. Keep the producer's budget aware of host provenance/identity overhead and surface a collection gap when optional enrichment cannot fit; a normalized source lookup must also inherit saved removed-name evidence or legacy unknown rather than imply no stripping.
