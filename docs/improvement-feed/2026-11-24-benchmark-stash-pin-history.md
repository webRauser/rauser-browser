## 2026-11-24 — Benchmark Stash lists with pin history

Extend the Stash native performance fixture with an untouched home, a mix of active pins, and a long history whose pins were all cleared. Pin-aware listing reads saved pin changes even when the final state has no active pins. Compare first-page and continuation costs in the combined Stash benchmark before adding a cache.

- +1 2026-11-24: The optimized Pin PR replay recorded 1,920 warm replies. A separate 9,998-change first read took 29.6 seconds. Keep the history-size experiment in brwr-2y1m.
