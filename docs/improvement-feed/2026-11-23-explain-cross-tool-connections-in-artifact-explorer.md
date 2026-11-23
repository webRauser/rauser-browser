## 2026-11-23 — Explain cross-tool connections in Artifact Explorer

Change: Design a web Artifact Explorer around a searchable, faceted artifact list and a selected-artifact preview, with an optional focused connection map.
Let people browse subjects, work topics, personal tags and source tools, inspect a short summary, and follow related artifacts while retaining their navigation trail.
Show why each connection appears: direct source link, citation, observed navigation, containment, shared subject or another inferred association.
Keep inferred associations visually and verbally distinct from recorded links; a shared label does not establish a dependency.

Why: The requested experience lets users recover related work across corporate tools from the labels and context accumulated as they worked.
The current artifact model records identity, capture activity, containment and navigation, while saved summaries contain richer metadata than the current list projection exposes.
The controlled subject system, rich facet indexing and related ranking remain proposed work; a concept mockup does not establish that these capabilities are shipped.
Begin with the user's captured library, label reading coverage and saved/observed dates, and keep corrections durable.

Where: DESIGN.md section 5.5, artifact and saved-summary projections, protocol/schema.json artifact queries, and the labelling design and related-search work.
Evaluate the first slice with synthetic cross-tool journeys: find a remembered item, browse one concern, inspect an artifact, and follow an explained connection to the original source.
This entry records the product direction and evaluation suggestion; implementation and deployment are separate work.
