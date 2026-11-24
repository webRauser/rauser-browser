use super::*;
use crate::index::links::{BACKLINKS_QUERY, MAX_BACKLINKS};
use crate::outbound_links::{CheckedObservation, StoredObservation, observation_key};
use brauser_protocol::{
    OutboundLinkCoverage, OutboundLinkCoverageState, OutboundLinkFrameScope,
    OutboundLinkObservation, OutboundLinkReason, OutboundLinkSource, OutboundLinkSourceKind,
    OutboundLinkTarget,
};

// timing-ok: fixture timestamps order log records and never use wall time.
const AT: &str = "2026-02-02T10:00:00Z";
// timing-ok: the file names only establish durable fixture replay order.
const SOURCE_LOG: &str = "2026-02-02.md";
// timing-ok: a second fixture day for the ID-conflict replay.
const RIVAL_LOG: &str = "2026-02-03.md";
const ID: &str = "00000000-0000-4000-a000-000000000001";

fn id(n: u128) -> String {
    Uuid::from_u128(Uuid::parse_str(ID).unwrap().as_u128() + n).to_string()
}

fn checked(source: &ActivityEvent) -> CheckedObservation {
    CheckedObservation {
        record: StoredObservation {
            source_artifact_id: source.artifact_id.clone(),
            source_artifact_type: source.artifact_type.clone(),
            observation: OutboundLinkObservation {
                observation_id: source.event_id.clone(),
                source: OutboundLinkSource {
                    kind: OutboundLinkSourceKind::Activity,
                    event_id: source.event_id.clone(),
                    occurred_at: source.occurred_at.clone(),
                    url: source.url.clone(),
                },
                observed_at: source.occurred_at.clone(),
                document_url: source.url.clone(),
                frame_scope: OutboundLinkFrameScope::TopDocument,
                frame_id: 0,
                policy_revision: "fixture".into(),
                coverage: OutboundLinkCoverage {
                    state: OutboundLinkCoverageState::Complete,
                    reason: None,
                    anchors_inspected: 1,
                },
                targets: vec![OutboundLinkTarget {
                    artifact_id: "work:example.com/future".into(),
                    artifact_type: "work.item".into(),
                    url: "https://example.com/items/future".into(),
                    label: Some("Future item".into()),
                }],
            },
        },
        provenance: UrlProvenance {
            source_unknown: true,
            document: Some(vec![]),
            targets: vec![vec![]],
            ..UrlProvenance::default()
        },
    }
}

fn marker(checked: &CheckedObservation) -> String {
    let o = &checked.record.observation;
    let marker = format!(
        "{MARKER_PREFIX}{} url={} at={} kind=links_to data={}{} -->",
        sha256_hex(observation_key(&o.observation_id).as_bytes()),
        sha256_hex(o.source.url.as_bytes()),
        o.observed_at,
        hex::encode(serde_json::to_vec(&checked.record).unwrap()),
        checked.provenance.marker(),
    );
    assert_eq!(
        crate::capture::links_marker(&marker).as_ref(),
        Some(checked)
    );
    format!("\n- Synthetic outbound observation\n{marker}\n")
}

fn append(log: &Path, text: &str) {
    let mut log = StdOpenOptions::new().append(true).open(log).unwrap();
    log.write_all(text.as_bytes()).unwrap();
}

fn detail(index: &ArtifactIndex, source: &ActivityEvent) -> Option<OutboundLinksView> {
    index
        .artifact_detail(&source.artifact_id)
        .unwrap()
        .outbound_links
}

fn at(
    source: &ActivityEvent,
    n: u128,
    time: &str,
    state: OutboundLinkCoverageState,
) -> CheckedObservation {
    let mut record = checked(source);
    let o = &mut record.record.observation;
    o.observation_id = id(n);
    o.observed_at = time.into();
    o.coverage.state = state;
    if state != OutboundLinkCoverageState::Complete {
        o.coverage.reason = Some(if state == OutboundLinkCoverageState::Partial {
            OutboundLinkReason::AnchorLimit
        } else {
            OutboundLinkReason::DocumentUnavailable
        });
    }
    if state == OutboundLinkCoverageState::Unavailable {
        o.targets.clear();
        o.coverage.anchors_inspected = 0;
        record.provenance.targets.clear();
    }
    record
}

#[test]
fn outbound_links_regenerate_only_the_owned_source_and_preserve_visits() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let known = activity(&id(20), "known", "Other recorded title", AT);
    let log = write_log(root.path(), SOURCE_LOG, &[&source, &known]);
    assert_eq!(index.regenerate_dirty().unwrap().written, 2);
    let path = root.path().join(artifact_file(
        "artifacts",
        &source.artifact_id,
        &source.artifact_type,
        "example.com",
    ));
    let legacy = fs::read_to_string(&path).unwrap();
    assert!(!legacy.contains("Outbound artifact links"));
    assert!(detail(&index, &source).is_none());
    let recent = index.recent(None, None, 32).unwrap();
    let mut observation = checked(&source);
    observation
        .record
        .observation
        .targets
        .push(OutboundLinkTarget {
            artifact_id: known.artifact_id.clone(),
            artifact_type: known.artifact_type.clone(),
            url: format!("{}&value=%%[[draft]]&valid=1", known.url),
            label: Some("![draft] `code` \u{202e}".into()),
        });
    observation.provenance.targets.push(vec![]);
    observation.record.observation.coverage.anchors_inspected = 2;
    append(&log, &marker(&observation));
    index.reconcile_from_logs().unwrap();
    assert_eq!(
        dirty_set(&index),
        BTreeSet::from([source.artifact_id.clone()])
    );
    assert_eq!(index.regenerate_dirty().unwrap().written, 1);
    let rendered = fs::read_to_string(&path).unwrap();
    assert!(rendered.contains("## Outbound artifact links"));
    assert!(rendered.contains("[Future item](<https://example.com/items/future>)"));
    assert!(
        !rendered.contains("![draft]")
            && !rendered.contains("`code`")
            && !rendered.contains('\u{202e}')
    );
    assert!(rendered.contains("&#38;value=&#37;&#37;&#91;&#91;draft&#93;&#93;"));
    let row = index.artifact(&source.artifact_id).unwrap().unwrap();
    assert_eq!(
        (row.opens, row.focused_seconds, row.linked_count),
        (1, 125, 0)
    );
    assert!(index.artifact("work:example.com/future").unwrap().is_none());
    assert_eq!(index.recent(None, None, 32).unwrap(), recent);
    let view = detail(&index, &source).unwrap().snapshot.unwrap();
    assert_eq!(view.targets[0].recorded_title, None);
    assert_eq!(
        view.targets[1].recorded_title.as_deref(),
        Some("Other recorded title")
    );
    assert!(
        !root
            .path()
            .join(artifact_file(
                "artifacts",
                "work:example.com/future",
                "work.item",
                "example.com",
            ))
            .exists()
    );
    let target = activity(&id(2), "future", "Recorded title", AT);
    append(&log, &activity_marker(&target));
    let card = detail(&index, &source).unwrap();
    let target_view = &card.snapshot.unwrap().targets[0];
    assert_eq!(
        target_view.recorded_title.as_deref(),
        Some("Recorded title")
    );
    assert_eq!(target_view.target.label.as_deref(), Some("Future item"));
    assert_eq!(
        target_view.target.url,
        observation.record.observation.targets[0].url
    );
    assert!(
        index
            .artifact_context(&source.artifact_id)
            .unwrap()
            .connections
            .is_empty()
    );
    assert!(
        index
            .artifact_context(&target.artifact_id)
            .unwrap()
            .connections
            .is_empty()
    );
    assert!(
        index
            .artifact(&target.artifact_id)
            .unwrap()
            .unwrap()
            .incoming_trails
            .is_empty()
    );
    assert_eq!(index.regenerate_dirty().unwrap().written, 1);
    append(&log, &marker(&observation));
    assert_eq!(index.regenerate_dirty().unwrap().written, 0);
    assert_eq!(fs::read_to_string(&path).unwrap(), rendered);
}

#[test]
fn outbound_links_order_collection_and_snapshot_by_instant_then_id() {
    use OutboundLinkCoverageState::{Complete, Partial, Unavailable};
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let log = write_log(root.path(), SOURCE_LOG, &[&source]);
    // timing-ok: checked log fixtures compare only observation instants.
    let unavailable = at(&source, 7, "2026-02-02T10:30:00Z", Unavailable);
    append(&log, &marker(&unavailable));
    let alone = detail(&index, &source).unwrap();
    assert_eq!(alone.collection.coverage.state, Unavailable);
    assert!(alone.snapshot.is_none());

    // timing-ok: a backdated fixture with a lexically greater timestamp.
    let mut earlier = at(&source, 5, "2026-02-02T11:20:00+01:00", Complete);
    let old_target = &mut earlier.record.observation.targets[0];
    old_target.artifact_id = "work:example.com/old".into();
    old_target.url = "https://example.com/items/old".into();
    old_target.label = Some("Old item".into());
    append(&log, &marker(&earlier));
    // timing-ok: these two different offsets represent the same instant.
    let tied_lower = at(&source, 3, "2026-02-02T11:25:00+01:00", Complete);
    // timing-ok: the later observation ID wins the same-instant tie.
    let mut partial = at(&source, 4, "2026-02-02T02:25:00-08:00", Partial);
    partial.record.observation.frame_scope = OutboundLinkFrameScope::SelectedDocument;
    partial.record.observation.frame_id = 4;
    partial.record.observation.document_url = "https://frame.example.test/selected".into();
    append(&log, &marker(&partial));
    append(&log, &marker(&tied_lower));
    let retained = detail(&index, &source).unwrap();
    assert_eq!(retained.collection, alone.collection);
    let snapshot = retained.snapshot.as_ref().unwrap();
    assert_eq!(snapshot.status.observation_id, id(4));
    assert_eq!(
        snapshot.status.observed_at,
        partial.record.observation.observed_at
    );
    assert_eq!(snapshot.status.coverage.state, Partial);
    assert_eq!(snapshot.targets.len(), 1);
    assert_eq!(
        snapshot.targets[0].target.artifact_id,
        "work:example.com/future"
    );
    assert_eq!(index.regenerate_dirty().unwrap().written, 1);
    let path = root.path().join(artifact_file(
        "artifacts",
        &source.artifact_id,
        &source.artifact_type,
        "example.com",
    ));
    let markdown = fs::read_to_string(&path).unwrap();
    assert!(markdown.contains("Collection unavailable at 2026-02-02T10:30:00Z"));
    assert!(markdown.contains("Showing the partial list observed at 2026-02-02T02:25:00-08:00"));
    assert!(!markdown.contains("Old item"));
    append(&log, &marker(&earlier));
    assert_eq!(index.regenerate_dirty().unwrap().written, 0);

    // timing-ok: a fixture instant later than all other observations.
    let mut empty = at(&source, 1, "2026-02-02T10:40:00Z", Complete);
    empty.record.observation.targets.clear();
    empty.provenance.targets.clear();
    // A later complete empty observation clears the partial list.
    append(&log, &marker(&empty));
    let cleared = detail(&index, &source).unwrap();
    assert_eq!(cleared.collection.coverage.state, Complete);
    assert_eq!(
        cleared.snapshot.as_ref().unwrap().status,
        cleared.collection
    );
    assert!(cleared.snapshot.as_ref().unwrap().targets.is_empty());
    let old = index
        .artifact_detail("work:example.com/old")
        .unwrap()
        .linked_from;
    assert_eq!(
        old.items[0].observed_at,
        earlier.record.observation.observed_at
    );
    let latest_positive = index
        .artifact_detail("work:example.com/future")
        .unwrap()
        .linked_from;
    assert_eq!(latest_positive.items.len(), 1);
    assert_eq!(
        latest_positive.items[0].observed_at,
        partial.record.observation.observed_at
    );
    assert_eq!(
        latest_positive.items[0].frame_scope,
        OutboundLinkFrameScope::SelectedDocument
    );
    assert_eq!(latest_positive.items[0].coverage.state, Partial);
    assert_eq!(index.reindex().unwrap().written, 1);
    assert_eq!(detail(&index, &source), Some(cleared));
    assert!(!fs::read_to_string(path).unwrap().contains("Future item"));
    assert_eq!(
        index
            .artifact_detail("work:example.com/future")
            .unwrap()
            .linked_from,
        latest_positive
    );
}

#[test]
fn backlinks_bound_distinct_sources_and_keep_whole_escaped_rows() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let sources = (0..9)
        .map(|n| {
            let mut source = activity(&id(n + 10), &format!("source-{n}"), "Title", AT);
            source.url = format!("https://example.com/items/source-{n}/{}", "a".repeat(8000));
            source
        })
        .collect::<Vec<_>>();
    let log = write_log(root.path(), SOURCE_LOG, &sources.iter().collect::<Vec<_>>());
    for source in &sources {
        append(&log, &marker(&checked(source)));
    }
    let target = "work:example.com/future";
    let bounded = index.artifact_detail(target).unwrap().linked_from;
    assert!(bounded.truncated);
    assert!(!bounded.items.is_empty() && bounded.items.len() < MAX_BACKLINKS);
    for (item, source) in bounded.items.iter().zip(sources.iter().rev()) {
        assert_eq!(item.source.url, source.url);
        assert_eq!(item.source.artifact_id, source.artifact_id);
    }
}

#[test]
fn sparse_backlink_queries_skip_unrelated_occurrences() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Title", AT);
    let log = write_log(root.path(), SOURCE_LOG, &[&source]);
    let mut observation = checked(&source);
    let rare = observation.record.observation.targets[0]
        .artifact_id
        .clone();
    append(&log, &marker(&observation));
    let work = |target: &str| {
        index
            .read(|tx| {
                let mut statement = tx.prepare(BACKLINKS_QUERY)?;
                let mut result = statement.query([target])?;
                let mut hits = 0;
                while result.next()?.is_some() {
                    hits += 1;
                }
                drop(result);
                Ok((
                    hits,
                    statement.get_status(rusqlite::StatementStatus::VmStep),
                ))
            })
            .unwrap()
    };
    let rare_before = work(&rare);
    let missing = "work:example.com/missing";
    let miss_before = work(missing);
    assert_eq!((rare_before.0, miss_before.0), (1, 0));
    for n in 1..=128 {
        let o = &mut observation.record.observation;
        o.observation_id = id(n);
        o.targets[0].artifact_id = format!("work:example.com/unrelated-{n}");
        append(&log, &marker(&observation));
    }
    for (after, before) in [(work(&rare), rare_before), (work(missing), miss_before)] {
        assert_eq!(after.0, before.0);
        // An index cursor can take a final step onto an adjacent target.
        // Unrelated observations must add only that constant exit work.
        assert!(after.1 <= before.1 + 4, "{after:?} vs {before:?}");
    }
}

#[test]
fn outbound_links_keep_the_label_when_the_target_has_no_recorded_title() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let mut target = activity(&id(2), "future", "", AT);
    target.title = None;
    let log = write_log(root.path(), SOURCE_LOG, &[&source, &target]);
    append(&log, &marker(&checked(&source)));
    let view = detail(&index, &source).unwrap().snapshot.unwrap();
    assert_eq!(view.targets[0].target.label.as_deref(), Some("Future item"));
    assert!(view.targets[0].recorded_title.is_none());

    let (revision, _) = index.relearn_evidence().unwrap();
    let preview = serde_json::to_value(
        index
            .relearn_projection(&Resolution::default(), &revision, None)
            .unwrap(),
    )
    .unwrap();
    let item = &preview["outbound_links"][&source.artifact_id]["snapshot"]["targets"][0];
    assert_eq!(item["target"]["label"], "Future item");
    assert!(item.get("recorded_title").is_none());
}

#[test]
fn outbound_links_replay_conflicts_across_logs_and_resume_bounded_rebuild() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let late = write_log(root.path(), RIVAL_LOG, &[&source]);
    let mut conflict = checked(&source);
    let later_target = &mut conflict.record.observation.targets[0];
    later_target.label = Some("Later log".into());
    later_target.artifact_id = "work:example.com/other".into();
    later_target.url = "https://example.com/items/other".into();
    append(&late, &marker(&conflict));
    assert_eq!(
        detail(&index, &source).unwrap().snapshot.unwrap().targets[0]
            .target
            .label
            .as_deref(),
        Some("Later log")
    );
    // The same ID with a conflicting body in an earlier log wins, even
    // though the cache ingested that file later.
    let early = write_log(root.path(), SOURCE_LOG, &[]);
    append(&early, &marker(&checked(&source)));
    let incremental = detail(&index, &source).unwrap();
    assert_eq!(
        incremental.snapshot.as_ref().unwrap().targets[0]
            .target
            .label
            .as_deref(),
        Some("Future item")
    );
    let targets = |index: &ArtifactIndex| {
        sql::sql_rows(
            &index.database_path(),
            "SELECT target_id FROM brauser_link_targets ORDER BY target_id",
        )
    };
    let target = |name: &str| vec![vec![sql::Value::Text(format!("work:example.com/{name}"))]];
    assert_eq!(targets(&index), target("future"));
    assert_eq!(
        sql::sql_rows(
            &index.database_path(),
            "SELECT observation_key FROM brauser_links",
        ),
        vec![vec![sql::Value::Text(observation_key(ID))]]
    );
    assert!(index.relearn_state().is_err());

    let cold_cache = TempDir::new().unwrap();
    let cold = ArtifactIndex::open_in(&index.storage, None, cold_cache.path()).unwrap();
    SCAN_LIMIT.with(|limit| limit.set(1));
    assert!(
        cold.artifact_detail(&source.artifact_id)
            .err()
            .unwrap()
            .to_string()
            .contains("per-pass limit")
    );
    assert!(cold.store_rebuilding());
    assert_eq!(detail(&cold, &source), Some(incremental));
    assert_eq!(targets(&cold), target("future"));
    SCAN_LIMIT.with(|limit| limit.set(MAX_SCAN_BYTES));

    // Removing the winning log promotes the other body on both paths.
    fs::remove_file(early).unwrap();
    let moved = detail(&index, &source).unwrap();
    assert_eq!(detail(&cold, &source), Some(moved.clone()));
    assert_eq!(targets(&index), target("other"));
    assert_eq!(targets(&cold), target("other"));
    drop(cold.reader.take(&cold.database_path()));
    remove_database(&cold);
    assert_eq!(detail(&cold, &source), Some(moved.clone()));
    assert_eq!(targets(&cold), target("other"));
    assert_eq!(
        moved.snapshot.unwrap().targets[0].target.label.as_deref(),
        Some("Later log")
    );
}

#[test]
fn backlinks_require_the_winning_owned_source_after_log_replacement() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let unrelated = activity(&id(2), "source", "Another visit", AT);
    let observation = checked(&source);
    let target = &observation.record.observation.targets[0].artifact_id;
    let log = write_log(root.path(), SOURCE_LOG, &[&source, &unrelated]);
    // A checked scan and its source can be in different daily logs.
    let link_log = write_log(root.path(), RIVAL_LOG, &[]);
    append(&link_log, &marker(&observation));

    let preview = |index: &ArtifactIndex| {
        let (revision, _) = index.relearn_evidence().unwrap();
        serde_json::to_value(
            index
                .relearn_projection(&Resolution::default(), &revision, None)
                .unwrap(),
        )
        .unwrap()
    };
    assert_eq!(
        preview(&index)["linked_from"][target]["items"][0]["source"]["artifact_id"],
        source.artifact_id
    );
    let live = |index: &ArtifactIndex| {
        let detail = index.artifact_detail(target).unwrap();
        assert!(detail.artifact.is_none());
        detail.linked_from
    };
    assert_eq!(live(&index).items[0].source.artifact_id, source.artifact_id);

    // Reuse the source UUID and artifact ID with a different URL, keeping the
    // same artifact in the library and the checked observation in another log.
    // The rewrite is the same size, so a truncate check alone cannot find it.
    let previous_size = fs::metadata(&log).unwrap().len();
    let mut replacement = source.clone();
    replacement.url = source.url.replace("/source?", "/edited?");
    write_log(root.path(), SOURCE_LOG, &[&replacement, &unrelated]);
    assert_eq!(fs::metadata(&log).unwrap().len(), previous_size);
    assert!(index.artifact(&source.artifact_id).unwrap().is_some());
    assert!(live(&index).items.is_empty());
    assert!(preview(&index)["linked_from"][target].is_null());

    let cold_cache = TempDir::new().unwrap();
    let cold = ArtifactIndex::open_in(&index.storage, None, cold_cache.path()).unwrap();
    assert!(cold.artifact(&source.artifact_id).unwrap().is_some());
    assert!(live(&cold).items.is_empty());
    assert!(preview(&cold)["linked_from"][target].is_null());

    write_log(root.path(), SOURCE_LOG, &[&unrelated]);
    assert!(index.artifact(&source.artifact_id).unwrap().is_some());
    assert!(live(&index).items.is_empty());
    assert!(preview(&index)["linked_from"][target].is_null());
}

#[test]
fn staged_backlinks_restart_when_a_preceding_source_log_changes() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let log = write_log(root.path(), SOURCE_LOG, &[&source]);
    let links = write_log(root.path(), RIVAL_LOG, &[]);
    let observation = checked(&source);
    append(&links, &marker(&observation));
    let source_size = fs::metadata(&log).unwrap().len();
    SCAN_LIMIT.with(|limit| limit.set(source_size));
    assert!(
        !index
            .rebuild_pass(crate::index::rebuild::Finish::All)
            .unwrap(),
        "the source is staged before the later observation"
    );
    SCAN_LIMIT.with(|limit| limit.set(MAX_SCAN_BYTES));
    let mut replacement = source.clone();
    replacement.url = source.url.replace("/source?", "/edited?");
    write_log(root.path(), SOURCE_LOG, &[&replacement]);
    assert_eq!(fs::metadata(&log).unwrap().len(), source_size);
    let target = &observation.record.observation.targets[0].artifact_id;
    assert!(
        index
            .artifact_detail(target)
            .unwrap()
            .linked_from
            .items
            .is_empty()
    );
}

#[test]
fn outbound_links_use_only_validated_identity_projection() {
    use crate::relearn::{
        Identity,
        aliases::{Action, Event},
    };
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let replacement = activity(&id(2), "replacement", "New source", AT);
    let log = write_log(root.path(), "day.md", &[&source, &replacement]);
    let mut observation = checked(&source);
    let first = observation.record.observation.targets[0].clone();
    observation.record.observation.targets.extend([
        OutboundLinkTarget {
            artifact_id: replacement.artifact_id.clone(),
            artifact_type: replacement.artifact_type.clone(),
            url: replacement.url.clone(),
            label: None,
        },
        OutboundLinkTarget {
            artifact_id: "work:example.com/target-alias".into(),
            url: "https://example.com/items/target-alias".into(),
            ..first.clone()
        },
    ]);
    observation.provenance.targets.resize(3, vec![]);
    observation.record.observation.coverage.anchors_inspected = 3;
    append(&log, &marker(&observation));
    let (revision, _) = index.relearn_evidence().unwrap();
    let reviewed = |n, from: &str, to: &str| {
        let identity = |key: &str| Identity {
            artifact_id: key.into(),
            artifact_type: "work.item".into(),
        };
        Event {
            event_id: id(n),
            action: Action::Confirm,
            from: identity(from),
            to: identity(to),
        }
    };
    let resolution = Resolution::from_events(&[
        reviewed(20, &source.artifact_id, &replacement.artifact_id),
        reviewed(21, "work:example.com/target-alias", &first.artifact_id),
    ])
    .unwrap();
    let preview = serde_json::to_value(
        index
            .relearn_projection(&resolution, &revision, None)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(preview["artifacts"].as_array().unwrap().len(), 1);
    assert!(preview["edges"].as_array().unwrap().is_empty());
    let list = &preview["outbound_links"][&replacement.artifact_id]["snapshot"]["targets"];
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["target"]["url"], first.url);
    assert_eq!(list[0]["target"]["artifact_id"], first.artifact_id);
    let backlinks = preview["linked_from"][&first.artifact_id]["items"]
        .as_array()
        .unwrap();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(
        backlinks[0]["source"]["artifact_id"],
        replacement.artifact_id
    );
    assert!(preview["linked_from"][&replacement.artifact_id].is_null());
    assert_eq!(
        detail(&index, &source)
            .unwrap()
            .snapshot
            .unwrap()
            .targets
            .len(),
        3
    );
    assert!(detail(&index, &replacement).is_none());
}

#[test]
fn outbound_links_read_only_complete_checked_markers_and_replay_format_nine() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let old = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let log = write_log(root.path(), SOURCE_LOG, &[&source]);
    let prefix = fs::read_to_string(&log).unwrap();
    let observe = marker(&checked(&source));
    append(&log, observe.trim_end_matches('\n'));
    assert!(detail(&old, &source).is_none());
    assert!(old.relearn_state().is_err());
    append(&log, "\n");
    let expected = detail(&old, &source).unwrap();
    assert!(old.relearn_state().is_ok());
    // Model a v9 cache that had already watermarked this complete marker
    // before the link projection existed.
    let mut conn = crate::index::store::open(cache.path()).unwrap();
    db::write_txn(&mut conn, |tx| {
        tx.execute("DROP TABLE brauser_link_targets", [])?;
        tx.execute("DROP TABLE brauser_links", [])?;
        tx.pragma_update(None, "user_version", 9)?;
        Ok(())
    })
    .unwrap();
    drop(conn);
    drop(old);
    let upgraded = index(&root, &cache);
    assert_eq!(detail(&upgraded, &source), Some(expected));
    assert_eq!(
        sql::sql_rows(&upgraded.database_path(), "PRAGMA user_version"),
        vec![vec![sql::Value::Integer(db::SCHEMA_VERSION)]]
    );

    // A detected rewrite replaces the existing observation with malformed
    // provenance. The lenient index clears its list; strict review refuses.
    fs::write(
        &log,
        format!("{prefix}{}", observe.replace(" stripped=", " invalid_=")),
    )
    .unwrap();
    assert!(detail(&upgraded, &source).is_none());
    assert!(upgraded.relearn_state().is_err());
    assert_eq!(upgraded.reindex().unwrap().failed, 0);
    assert!(detail(&upgraded, &source).is_none());

    let unowned = log.with_file_name("unowned.md");
    fs::write(&unowned, format!("{LOG_HEADER} suffix\n{observe}")).unwrap();
    assert!(detail(&upgraded, &source).is_none());
}

#[test]
fn backlinks_replay_a_populated_format_ten_cache() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let old = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let log = write_log(root.path(), SOURCE_LOG, &[&source]);
    let checked = checked(&source);
    let target = &checked.record.observation.targets[0].artifact_id;
    append(&log, &marker(&checked));
    let expected = old.artifact_detail(target).unwrap().linked_from;
    assert_eq!(expected.items.len(), 1);
    let mut conn = crate::index::store::open(cache.path()).unwrap();
    db::write_txn(&mut conn, |tx| {
        tx.execute("DROP TABLE brauser_link_targets", [])?;
        tx.pragma_update(None, "user_version", 10)?;
        Ok(())
    })
    .unwrap();
    drop(conn);
    drop(old);
    let upgraded = index(&root, &cache);
    assert_eq!(
        upgraded.artifact_detail(target).unwrap().linked_from,
        expected
    );
    assert_eq!(
        sql::sql_rows(&upgraded.database_path(), "PRAGMA user_version"),
        vec![vec![sql::Value::Integer(db::SCHEMA_VERSION)]]
    );
}

#[test]
fn outbound_links_preserve_unowned_artifact_and_user_note_bytes() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let log = write_log(root.path(), SOURCE_LOG, &[&source]);
    let path = root.path().join(artifact_file(
        "artifacts",
        &source.artifact_id,
        &source.artifact_type,
        "example.com",
    ));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "unowned artifact\n").unwrap();
    let note = root.path().join("pages/user.md");
    fs::create_dir_all(note.parent().unwrap()).unwrap();
    fs::write(&note, "user-owned content\n").unwrap();
    append(&log, &marker(&checked(&source)));
    assert_eq!(index.regenerate_dirty().unwrap().conflicts, 1);
    assert_eq!(index.reindex().unwrap().conflicts, 1);
    assert_eq!(fs::read_to_string(path).unwrap(), "unowned artifact\n");
    assert_eq!(fs::read_to_string(note).unwrap(), "user-owned content\n");
    assert!(detail(&index, &source).is_some());
}
