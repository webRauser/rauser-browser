use super::*;
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
    let partial = at(&source, 4, "2026-02-02T02:25:00-08:00", Partial);
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
    assert_eq!(index.reindex().unwrap().written, 1);
    assert_eq!(detail(&index, &source), Some(cleared));
    assert!(!fs::read_to_string(path).unwrap().contains("Future item"));
}

#[test]
fn outbound_links_replay_conflicts_across_logs_and_resume_bounded_rebuild() {
    let (root, cache) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let index = index(&root, &cache);
    let source = activity(ID, "source", "Source", AT);
    let late = write_log(root.path(), RIVAL_LOG, &[&source]);
    let mut conflict = checked(&source);
    conflict.record.observation.targets[0].label = Some("Later log".into());
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
    SCAN_LIMIT.with(|limit| limit.set(MAX_SCAN_BYTES));

    // Removing the winning log promotes the other body on both paths.
    fs::remove_file(early).unwrap();
    let moved = detail(&index, &source).unwrap();
    assert_eq!(detail(&cold, &source), Some(moved.clone()));
    drop(cold.reader.take(&cold.database_path()));
    remove_database(&cold);
    assert_eq!(detail(&cold, &source), Some(moved.clone()));
    assert_eq!(
        moved.snapshot.unwrap().targets[0].target.label.as_deref(),
        Some("Later log")
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
