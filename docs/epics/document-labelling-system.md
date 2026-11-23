# Document Labelling System

Created: 2026-11-22
Status: Planned epic; the product capability is not implemented by these briefs.

## Product outcome

Give people useful, consistent primary subject labels from their first saved document, across professional and personal interests.
The system should identify the concern that connects a document's content, even when the label itself never appears in the text.
People should receive useful defaults without labelling a training set or configuring a profession-specific taxonomy.
Their corrections should remain authoritative for the documents they edit.

## Problem

Keywords, named entities and document types answer different discovery questions.
A team or organization identifies context, while a subject describes what the document principally concerns.
For example, a synthetic service-health report about defects, incidents and availability may principally concern Quality, while a recovery procedure principally concerns Operations.
Choosing a prominent keyword cannot consistently make that distinction.

Free-form subject generation also risks fragmenting similar documents across inconsistent terms.
A fixed narrow vocabulary risks excluding professions and personal interests that its authors did not anticipate.
This epic covers a product and technical approach that balances useful first-document judgments with stable concept reuse and durable user choices.

## Intended experience

- A saved document receives one primary subject, with an optional second when both independently represent substantial content.
- Subject labels remain distinct from people, organizations, products, places, document types and detailed search terms.
- A person can inspect a brief reason and replace a label during normal use.
- Limited reading and insufficient evidence remain visible rather than becoming confident claims about an unread document.
- Reopening, retrying a save or rebuilding an index preserves the accepted classification.
- Model, vocabulary and profile changes do not silently relabel historical documents.

The existing delivery task proposes an editable profile about responsibilities and retrieval goals.
The design must decide whether and how to offer that refinement without making it a prerequisite for useful labels.
Profile information may influence prominence only when supported by document content; a person's profession must not predetermine the subject.

## Scope

1. Define the subject-selection policy, granularity, cardinality and uncertainty behavior.
2. Establish concept identity, definitions, aliases, relationships, vocabulary versions and controlled library-local extensions.
3. Define and evaluate the classifier, including its relationship to the user's general summary runner.
4. Preserve assignments, provenance, reading coverage and user overrides in authoritative storage that survives cache rebuilds.
5. Integrate labels and corrections with saved summaries and the relevant discovery surfaces.
6. Establish product-owned evaluation across domains, languages and ambiguous cases selected by the design.

The candidate architecture is a versioned concept catalog, constrained subject selection and durable assignments.
It is a proposal to assess, not an approved implementation specification or a selected model.

## Boundaries

- Customer-labelled training sets and compulsory profession setup are outside the intended onboarding contract.
- Exact agreement with every person's preferred abstraction is not promised.
- Automatic historical reclassification, silent concept merges and broad behavioral profiling are outside the initial scope.
- An embedding service, vector database, custom trained model or RDF server is not a prerequisite; additions need evidence from evaluation and scale.
- The product must remain standalone and retain its existing capture, folder authority and untrusted-input boundaries.
- These briefs create planning context; they neither authorize starting the design automatically nor claim that the design or delivery work is complete.

## Work and sequencing

| Work | Brief | Relationship |
| --- | --- | --- |
| Designing a Document Labelling System | [Design task](../tasks/designing-a-document-labelling-system.md) | First: produce and review the product and technical design. |
| Add personalized, consistent primary-subject labeling | [Delivery task](../tasks/personalized-primary-subject-labelling.md) | Existing work grouped under this epic; follows the reviewed design. |

Implementation slices should be derived from the reviewed design rather than treated as additional commitments in this epic brief.
The earlier research proposal remains recorded in the [improvement feed](../improvement-feed/2026-11-19-purpose-based-primary-subjects.md).

## Epic acceptance

- Useful first-document labels are demonstrated on a product-owned corpus spanning several professional and personal domains.
- Semantically supported subjects can be assigned without literal label occurrence, while incidental mentions do not establish primacy.
- Similar documents reuse appropriate concepts without collapsing distinct meanings into one label.
- Subject choice, grouping usefulness, uncertainty, consistency, latency and cost meet thresholds agreed during design.
- Accepted classifications and user overrides survive save retries, restarts and index rebuilds.
- A new model or catalog version does not silently overwrite previous decisions or explicit user choices.
- Evidence distinguishes design approval, implementation, automated verification and any live acceptance still required.

## Main risks

An overly broad subject may be consistent but unhelpful; an overly specific vocabulary may fragment retrieval.
Novel-concept resolution and model changes can introduce semantic drift even when record identities are stable.
Partial captures can bias a label toward the visible section rather than the whole document.
Differences between summary runners may undermine fresh-run consistency unless the classifier contract controls or measures them.
The design task must turn these risks into explicit decisions, tests and operating limits.

## Research references

- [NLM subject-analysis policy](https://www.nlm.nih.gov/tsd/cataloging/subjclasspolicy.html): primary and secondary subject practice.
- [NISO controlled-vocabulary guidelines](https://www.niso.org/publications/ansiniso-z3919-2005-r2010): vocabulary, facets and scope.
- [W3C SKOS Primer](https://www.w3.org/TR/skos-primer/): stable concepts, labels, definitions and relationships.
- [Gen-Z, ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/af7cc9e2366b8f8837a6ef339810277a-Abstract-Conference.html): zero-shot classification with contextual label descriptions.

These references inform the design; they do not establish the accuracy of an unbuilt Brauser classifier.
