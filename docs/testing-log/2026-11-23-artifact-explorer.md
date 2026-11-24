## 2026-11-23 — Existing-data Artifact Explorer checks

Synthetic validation of the sidebar launch and full-page Explorer covered the host query, wire contracts, strict response guards, page state and actual browser interaction.

- Explorer host tests: 14 passed, including unique multi-day records, latest-summary tie behavior, Unicode token search, exact padded facets, stale snapshots, relationship meanings/caps, unchanged reads and bounded presentation without modifying stored records.
- Saved-summary opener tests: 7 passed, including stale/cross-home refusal before an opener call and legacy omission compatibility.
- Protocol Explorer and summary wire tests: 10 passed. Strict Explorer response guards: 7 passed.
- Frontend model/handoff/sidebar tests: 17 passed, including late replies, paging, filter reconciliation, refreshed metadata mismatch, safe source URLs and opening a main-area browser page without adding a sidebar tab.
- Focused real-browser Explorer cases: 16 passed, with no reported axe violations or incomplete checks in their audits. These include both themes and setup/error/disconnected states, paused capture without an agent, filters, paging, saved-summary revision binding, literal hostile text, coverage distinctions, connections beyond filters and an empty library.
- Browser inspection found no horizontal overflow at widths 760 and 390. The inspected artifacts and screenshots were synthetic.

Review reproduced and corrected a final-page pagination focus loss, an invalid ARIA group label, a stale summary-open action crossing home folders, ordinary selection retaining mismatched newer metadata, oversized historical presentation fields and padded saved-facet mismatch.
The final-page regression verifies keyboard focus transfers to the first appended artifact.
An initial equal-time fixture assumption was corrected to the already established durable log order; the new query agrees with the existing latest-summary read.

These checks ran against a disposable browser profile and fake Chrome/native transport, temporary host storage and an injected opener.
They do not certify real source freshness, completeness of a user's captured library or a Chrome-loaded deployment.
The README gate, required CI and supported live deployment retain their separate evidence and runbook.
