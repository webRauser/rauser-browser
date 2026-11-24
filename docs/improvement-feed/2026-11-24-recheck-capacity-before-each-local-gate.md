## 2026-11-24 — Recheck capacity before each local gate

Record load and available disk at the start of each expensive local gate. Apply the repository's existing load rule when a gate starts and record which completed checks can be reused. A full Stash browser suite took 19m 40s, and the parallel format-guard build was interrupted when one-minute load exceeded 32 on 12 cores and free space fell to 2.3 GiB. Put the observation in the contributor workflow and report rebuildable artifacts from finished lanes as cleanup candidates.
