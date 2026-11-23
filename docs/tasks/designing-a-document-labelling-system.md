# Designing a Document Labelling System

Created: 2026-11-22
Status: To do; this file commissions the design and is not the completed design.
Epic: [Document Labelling System](../epics/document-labelling-system.md).
Delivery handoff: [Add personalized, consistent primary-subject labeling](personalized-primary-subject-labelling.md).

## Goal

Produce a reviewed product and technical design that explains how Brauser will assign useful, consistent primary subjects across domains from the first document.
Resolve implementation-blocking decisions, specify measurable acceptance criteria and provide a practical delivery handoff.
No customer training exercise or profession-specific configuration should be required to obtain useful results.

## Scope of this task

This task covers design, bounded technical investigation and an evaluation plan.
It does not implement or deploy the capability, complete classifier benchmarking, or declare a model selected without evidence.
Any experiment or prototype needed to resolve a decision must have its own explicit scope and evidence.

## Required design content

### Product and classification contract

Define what the primary subject represents, the intended abstraction level, when to assign a second subject and how to distinguish subjects from entity and document-type facets.
Specify mixed-content, partial-capture, viewer-only, insufficient-evidence and no-suitable-concept behavior.
Describe label explanation, correction, reclassification and the authority and scope of user overrides.
Decide how optional user context can refine prominence without inventing unsupported subject matter or creating onboarding work.

Use synthetic examples from education, law or property, nonprofit work, research, personal interests and engineering.
Include competing interpretations such as Quality versus Operations and allow defensible alternatives in evaluation.

### Concepts and vocabulary governance

Specify concept IDs, display labels, definitions, inclusion and exclusion rules, aliases, relationships, namespaces and versions.
Define the shipped catalog, library-local concepts, supported languages and the separation between a display-name edit and a meaning change.
Explain proposal, reuse, semantic deduplication, provisional status, concurrent creation, retirement and any explicit merge process.
Do not treat associated concepts such as defects and Quality as interchangeable synonyms.

### Classifier and model contract

Define the captured or retrieved content, source identity, reading coverage, catalog snapshot and explicit preferences supplied to classification.
Do not rely only on generated keywords or on a lossy summary as the evidence for a decision.
Specify constrained outputs, evidence references, reasons, failure states and the Rust validator's responsibilities and limits.
Distinguish structural validity and preserved decisions from probabilistic semantic correctness.

Compare an independently versioned classifier profile with reuse of existing summary runners.
Document model and prompt version controls, runtime and deployment options, document-processing boundaries, credential handling, latency, cost and offline expectations.
Do not promise cross-installation fresh-run reproducibility solely because decoding settings are fixed.

Evaluate full-catalog classification as the simplest starting point while the catalog fits a measured input budget.
Introduce lexical or embedding candidate retrieval only if scale or evaluation justifies it, and measure whether the correct concepts reach the classifier.
Similarity may retrieve candidates; it must not by itself establish a document's primary concern.

### Durable records, recovery and compatibility

Specify authoritative concept, assignment and override records, the disposable index projection and complete recovery after an index rebuild.
Retain available source revision or input identity, reading coverage, catalog and classifier versions, accepted evidence and user corrections.
Define idempotent retries, stale-result rejection, concurrent writes and behavior after a document changes.
Explain reclassification, catalog evolution, model upgrades and profile edits without silently rewriting historical decisions.
Include format compatibility, migration and rollback implications before changing a saved-data contract.

### Evaluation and delivery handoff

Design a product-owned cross-domain corpus with development and held-out sets, including first-document cases, ambiguous alternatives, absent label words, partial captures and novel subjects.
Define measurement and acceptance thresholds for subject usefulness, grouping and retrieval, fresh-run agreement, vocabulary fragmentation, override preservation, latency and cost.
LLM-reported confidence alone is not measured accuracy.
Identify any languages or document classes outside the initial supported scope.

Provide a delivery sequence of independently reviewable changes, required checks and rollout/recovery evidence.
Keep future implementation steps in the resulting plan rather than creating a tracker task for every file or mechanism.

## Starting architecture to challenge

Document content and reading coverage feed a classifier that selects IDs from a versioned concept catalog.
The host validates the result and preserves it in authoritative records; the UI and rebuildable index consume that saved decision.
A separate resolution path handles subjects that the catalog cannot adequately express.

Challenge whether this mechanism is the simplest useful solution before committing to its storage or model strategy.
Follow the repository's [plan requirements](../superpowers/README.md), including the design challenge and any required guard-invariant evidence when the resulting implementation plan reaches those gates.

## Decisions to resolve

| Decision | Current state | Before implementation |
| --- | --- | --- |
| Starter catalog breadth, granularity and language support | Open | Define supported scope and competing-label boundaries. |
| One versus two subjects and their presentation | Proposed: one by default | Resolve independent second-subject criteria and ambiguity behavior. |
| Optional profile and correction scope | Existing delivery task proposes a profile | Specify useful defaults and optional refinement without requiring training labels. |
| Classifier model, runtime and version control | Open | Select using evidence or define an explicit bounded evaluation prerequisite. |
| Full catalog versus candidate retrieval | Proposed: full catalog first | Establish input-budget and retrieval-quality triggers. |
| Novel-concept admission and semantic duplication | Open | Define provisional states, concurrent resolution and explicit merge authority. |
| Authoritative storage and schema compatibility | Open | Demonstrate recovery and override preservation in the proposed format. |
| Historical reclassification and model/catalog upgrades | Proposed: preserve accepted decisions | Specify explicit update behavior and its authority. |
| Quality, resource and release thresholds | Open | Set measurable acceptance and operating limits. |

These are design questions, not approval requests required to create this task or its brief.
No implementation dependent on an unresolved decision should start.

## Completion criteria

- A dated design specification is saved under `docs/superpowers/specs/` and linked from this brief.
- The specification contains concrete data records, classifier input/output contracts, state transitions, failure paths and ownership boundaries.
- Material alternatives and the simpler-design challenge are recorded with reasons for the chosen approach.
- Implementation-blocking decisions are resolved, or the affected work is explicitly deferred with an owner and prerequisite.
- Cross-domain evaluation methods, measurable thresholds and any prerequisite model evaluation are defined without assigning customers a labelling task.
- Storage, recovery, overrides, version changes and compatibility are covered by a verification plan.
- The design is reviewed and a delivery handoff is recorded; creating this brief alone satisfies none of those gates.

## Source areas to inspect

Verify the current implementation at design start rather than assuming the research snapshot remains current.
Relevant seams include [summary instructions](../../SUMMARY.md), [answer parsing and schema](../../host/src/answer.rs), [prompt construction](../../host/src/service/prompt.rs), [summary finishing](../../host/src/service/finisher.rs), [summary rendering and events](../../host/src/summary.rs) and the [rebuildable index](../../host/src/index/mod.rs).
The [epic brief](../epics/document-labelling-system.md#research-references) holds the research starting points.
