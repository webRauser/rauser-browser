## 2026-11-19 — Evaluate purpose-based primary subjects

Change: Prototype one primary subject and an optional second subject selected from a small, user-defined controlled vocabulary, with definitions, inclusion rules and counterexamples.
Keep subject labels separate from team, product, document type and search keywords.
Permit an inferred subject when the document supports the concept even without naming the label; record supporting evidence, reading coverage and user overrides.
Evaluate the prototype on user-labeled examples and ambiguous cases before enabling automatic classification.

Why: Keyword extraction can surface defects, incidents and availability without supplying a useful organizing subject such as Quality.
A team name, product name and broader concern answer different retrieval questions and should not have to compete for the same field.
Partial captures and genuinely mixed subjects also require an explicit way to preserve uncertainty.

Where: Summary classification instructions, answer validation and saved-summary metadata, with taxonomy definitions and an evaluation corpus designed before changing the shipped contract.

- +1 2026-11-22: Product planning now distinguishes an epic, a design task and the existing delivery task in [the epic brief](../epics/document-labelling-system.md). The initial evaluation suggestion should be owned by the product team, with useful first-document defaults across domains and no customer-labelled training set; model control, durable assignments and optional personalization require a reviewed design before implementation.
