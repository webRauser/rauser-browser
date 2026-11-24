## 2026-11-24 — Time Stash native search by phase

Add separate receipt acquisition, Done projection, owned-content and reply timings to the synthetic Stash replay. At 2,000 saves, four checked readers reduced receipt acquisition by about 190 to 200 ms at median. Expanded queries still missed the 250 ms warm p95 target, and the end-to-end timings could not attribute the remaining cost. Record warm and fresh runs separately and compare complete replies to the sequential reference before adopting a faster path. Track in `brwr-ozgq`.

- +1 2026-11-24: A second timed replay found receipt acquisition and live Done projection dominate expanded search. Retain both first-page and continuation measurements, with ambient load and exact reply comparisons.
