## 2026-11-23 — Run joined link acceptance in headless smoke

Change: Reuse the disposable outbound-link acceptance case in the macOS headless smoke gate once its runtime and platform requirements are measured.
Why: The regular extension and native suites cover their own boundaries. The joined case also catches drift in the source acknowledgement, replay and panel refresh sequence.
Where: The existing headless smoke run and its build of the scripted debug host.

- Done 2026-11-23: brwr-pfuf adds the named acceptance step and requires a passing result in headless smoke.
