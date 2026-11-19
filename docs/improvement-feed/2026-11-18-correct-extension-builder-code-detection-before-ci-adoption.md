## 2026-11-18 — Correct Extension Builder code detection before CI adoption

Change: Keep Chrome Extension Builder's static checker advisory until its case-insensitive `Function` detector is corrected and covered by fixtures that distinguish ordinary `function (...)` callbacks from actual `Function(...)` and `eval(...)` calls. Review a corrected version before adopting its check/package helpers in CI; retain Brauser's existing gates.

Why: The v2.3.0 checker exited 1 on Brauser's existing `ca68178f818f` development artifact because `re.I` makes its `Function` alternative match ordinary lowercase functions in bundled Readability. The distributed dependency matches the SHA-256 pin enforced by `extension/build.mjs`; this finding demonstrates a checker false positive. Its broad-host warning also needs interpretation against Brauser's deliberate open-access design.

Where: The vendor's `skills/chrome-extension-builder/scripts/check_extension.py:27` and its regression fixtures; evaluate any future integration against `extension/dist` after Brauser's normal build. Keep installed vendor files unchanged. See [the fit review](../reviews/2026-11-18-chrome-extension-builder.md) for observed output, limits and a focused note-recovery pilot.
