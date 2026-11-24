## 2026-11-24 — Isolated link and arrival evidence checks

The joined outbound links fixture checks a partial link from A to never-visited B, then a distinct attributed new-tab navigation.
Before navigation B has a dated backlink and no known arrival, activity measures, artifact file, or Explorer entry.
After normal delivery the same backlink and the independently recorded arrival appear in the built panel and Explorer.
The test uses the existing scripted host, routed synthetic Chromium pages, keyboard actions and an Explorer axe audit.

The source-binding fixture first exposed a stale backlink after a same-size rewrite of the owning event in another daily log.
The correction rebuilds the occurrence projection when a detected rewrite affects a checked marker or its source, and tests compare live catch-up, cold replay and interrupted staging.

Independent review found a distinct ordering case where the owning log changes before its first checked observation exists.
The failing fixture catches up the same-size, same-UUID rewrite before appending the first checked positive to a different log.
Catch-up now checks the previous source bindings against the already-read rewritten log before committing its watermark.
A companion fixture changes an activity title while preserving the binding and still reads only that log.

The joined case also keeps keyboard focus on both a backlink and a recorded arrival through refreshes that return unchanged evidence.
The existing Explorer disconnection audit checks that the unavailable state is visible in both themes.

The source eligibility regression rewrites a checked link's owner in a synthetic log while preserving its identity and leaving an ordinary visit for the same artifact.
Warm catch-up, cold replay and strict preview all exclude owners that existing capture checks reject because they are incognito, have no capture evidence, or carry an unknown transition.
An earlier eligible observation for the same artifact still qualifies before deduplication and the response limit.
