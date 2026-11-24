## 2026-11-23 — Show outbound link delivery gaps by phase

Change: In local diagnostics, show bounded counts for collection failures, source binding failures, and publication failures, with the most recent time for each phase.
Why: A vanished staging token and a completed hourly source whose URL changed both leave the activity intact but need different investigation. The retained list alone cannot explain either outcome.
Where: The background worker's outbound delivery state, the native stage receipt, and the existing settings diagnostics view. Report counts, times, and fixed reasons without document addresses or target labels.
