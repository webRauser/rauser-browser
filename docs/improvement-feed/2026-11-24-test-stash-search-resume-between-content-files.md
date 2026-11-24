## 2026-11-24 — Test Stash search between summary and note reads

Measure how often a Stash search slice stops at a record whose summary fits the remaining byte budget and whose note would exceed it. The private prototype reserves both together, which preserves a complete record boundary and can leave some capacity unused. Include this case in the mixed-queue native fixture before choosing whether a continuation needs to resume between files.
