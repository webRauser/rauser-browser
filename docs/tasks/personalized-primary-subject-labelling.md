# Add personalized, consistent primary-subject labeling

Created: 2026-11-22
Status: To do; existing delivery task, now grouped under the epic.
Epic: [Document Labelling System](../epics/document-labelling-system.md).
Prerequisite: [Designing a Document Labelling System](designing-a-document-labelling-system.md).

## Outcome

Deliver useful primary subjects for saved documents with consistent meanings and an organizing perspective that can suit each user.
Work across professions and personal interests without asking customers to label a training set.
Keep accepted decisions and explicit corrections durable.

## Relationship to the design task

This brief provides delivery context for an existing task; it does not create a second implementation commitment.
The design task defines the reviewed contracts, acceptance thresholds and implementation sequence before dependent delivery work begins.
This delivery task remains open while that design is pending.

The existing task description includes a brief editable onboarding profile covering work, responsibilities and retrieval goals.
The design must determine its optional presentation and influence while preserving useful first-document results.
This brief retains that context without treating an unreviewed profile or model strategy as a settled implementation choice.

## Delivery scope

- Integrate the reviewed subject-selection contract with the summary pipeline, using stable concept identities and explicit reading coverage.
- Implement catalog and library-local concept behavior, including the reviewed no-suitable-concept and provisional-concept paths.
- Implement the chosen classifier configuration, structured outputs and host validation with evidence of its actual version controls.
- Persist assignments, available source/input identity, catalog/profile/classifier versions and overrides outside the sole authority of a disposable index.
- Present primary subjects, explanations and editable labels, with the discovery/filtering behavior chosen in the design.
- Preserve user edits, accepted results across save retries and complete recovery after index rebuilds.
- Make model, catalog, profile and historical reclassification behavior follow the reviewed authority and compatibility rules.

## Acceptance

- The design prerequisite is reviewed and the delivery sequence names its resolved contracts and any deferred work.
- Product-owned cross-domain evaluation meets the agreed usefulness, grouping, consistency, latency and cost thresholds.
- First-document behavior requires no customer-labelled training set and does not depend on an engineering vocabulary.
- Known synthetic cases cover implied subjects, competing labels, mixed concerns, partial reading and insufficient evidence.
- Regression evidence covers stale results, retry behavior, concurrent concept decisions, index rebuilds and user overrides.
- The owning design and shipped-state documents reflect what was actually delivered.
- Required platform checks, review and merge gates pass, and any installed/live acceptance remains distinguished from CI evidence.

## Boundaries and handoff

Do not implement the architecture merely by treating the earlier research conversation as a final specification.
Create implementation beads or plans only for work derived from the reviewed design and follow the repository's queue and contributor contracts.
Do not silently overwrite user labels or bulk-reclassify historical documents as a side effect of upgrades.
Keep examples synthetic and the product independent of any contributor's knowledge base or management tools.

Next action: complete the design prerequisite, then refine this task's delivery sequence and acceptance evidence from that reviewed result.
