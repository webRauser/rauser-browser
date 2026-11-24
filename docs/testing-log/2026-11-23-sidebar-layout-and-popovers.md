## 2026-11-23 — Exercise fixed sidebar zones and native popovers

The sidebar's browser fixtures now open Options and Activity through keyboard-accessible native popover triggers before reaching their controls.
Long unbroken page titles exposed a grid min-content expansion in the fixed task composer; a `minmax(0, 1fr)` track and shrinkable metadata row prevent horizontal overflow.
The viewport matrix covers 320 × 640 and 420 × 800 in both themes, view switching, long run output, classification and reading coverage, native dismissal and independent scroll positions.
Site options retain their open disclosure while review cancellation restores focus to its originating control.

A source rebuild replaces `extension/dist/`; running that rebuild during the browser suite can produce an unrelated ENOENT while the fixture reads its next page.
Build first and keep the output stable until the suite completes.
Headless smoke must open Activity before clicking the capture housekeeping disclosure.
Synthetic/browser evidence does not establish live Chrome loading or a real harness result, and axe's incomplete/manual-review findings must remain distinct from passed checks.

The final focused browser run passed 14/14 cases with no skips, including the four viewport/theme combinations and twenty axe audits without serious or critical violations.
The first-run warning paragraph inside an open Activity overlay remains an overlap-sensitive manual contrast review item; it is not counted as an automated contrast pass.
The full extension suite passed 3,199 tests; the final panel/run-card rerun passed 581.
The full Rust run had one queue-test wait timeout under heavy machine load; its exact isolated rerun passed in 1.66 seconds.
Remaining broad developer-tool checks were left to CI after load rose above twice the twelve-core machine's capacity; a deliberately stopped script run recorded 524 passes and one cancellation, not a passing full suite.
