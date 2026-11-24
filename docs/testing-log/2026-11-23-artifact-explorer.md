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

The README gate passed workspace Rust build/tests, formatting, Clippy, Windows compilation, fuzz compilation, TypeScript, ESLint, extension build, all 3,223 extension tests, all 80 accessibility/browser cases and the Markdown neutralizer corpus.
The browser suite took 773 seconds and Rust workspace tests took 301 seconds.
The gate began at load 13.71 on 12 cores; after load rose to 44.53, the remaining general script suite was stopped, and broad queue/developer-tool suites were left to CI under the repository load rule.
The stopped script suite is not a local pass.

After the sidebar redesign merged, two actual conflicts in browser fixtures/tests were resolved by preserving both features; the PR doctor identified those code conflicts as requiring owner resolution.
The combined build, TypeScript and scoped lint passed, as did 26 Explorer unit/guard/launch cases.
The focused browser integration run passed 27 cases covering Explorer, closed Activity and fixed sidebar zones at 320×640 and 420×800 in both themes.
Its additional warning case initially expected a nested closed Notice to be visible; after explicitly opening that disclosure, the isolated rerun passed with no axe violations or incomplete checks.
Explorer launch failures now use the existing Activity warning signal and retain keyboard focus without starting an agent or changing capture.
