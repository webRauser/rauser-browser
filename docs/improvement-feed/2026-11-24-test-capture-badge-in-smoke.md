## 2026-11-24 — Check the capture badge in the native-host smoke run

Extend the headless macOS capture smoke test to switch between a fixture site with saved rules and one with no rules, then check the header badge on both.
The header displayed green on sites without rules while global capture was on, and the smoke run checked only the global capture strip.
Add the assertions beside the pause and resume checks in `scripts/smoke-macos.mjs`.
