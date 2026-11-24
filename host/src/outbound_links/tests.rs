use super::*;
use brauser_protocol::*;
use sha2::Digest;
use std::path::PathBuf;

struct Fixture {
    folder: tempfile::TempDir,
    root: PathBuf,
    config: ConfigStore,
    source: ActivityEvent,
}

impl Fixture {
    fn new() -> Self {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().join("home");
        std::fs::create_dir(&root).unwrap();
        let path = folder.path().join("config.toml");
        crate::config::fixtures::write(
            &path,
            &root,
            "",
            "capture_enabled = true\nstrip_params = [\"utm_*\"]",
            "[adapters]\nformat = 1\n[[artifacts]]\ntype = \"work.item\"\norigin = \"https://work.example\"\nmatch = [{path = \"/items/{id:int}\"}]\nid = \"work:{host}/{id}\"\n",
        );
        let mut config = ConfigStore::for_test(path);
        config.refresh().unwrap();
        let source = ActivityEvent {
            focus_session: None,
            event_id: uuid::Uuid::new_v4().to_string(),
            artifact_id: "work:work.example/1".into(),
            artifact_type: "work.item".into(),
            url: "https://work.example/items/1".into(),
            title: Some("Source".into()),
            occurred_at: crate::capture::fixtures::event_time()
                .replace_nanosecond(0)
                .unwrap()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
            incognito: false,
            opens: 1,
            focused_seconds: 1,
            background_seconds: 0,
            modes: vec![],
            trails: vec![],
            refs: vec![],
        };
        Self {
            folder,
            root,
            config,
            source,
        }
    }

    fn request(&self) -> RecordOutboundLinksRequest {
        RecordOutboundLinksRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "links".into(),
            observation: OutboundLinkObservation {
                observation_id: uuid::Uuid::new_v4().to_string(),
                source: OutboundLinkSource {
                    kind: OutboundLinkSourceKind::Activity,
                    event_id: self.source.event_id.clone(),
                    occurred_at: self.source.occurred_at.clone(),
                    url: self.source.url.clone(),
                },
                observed_at: self.source.occurred_at.clone(),
                document_url: self.source.url.clone(),
                frame_scope: OutboundLinkFrameScope::TopDocument,
                frame_id: 0,
                policy_revision: self.config.revision().into(),
                coverage: OutboundLinkCoverage {
                    state: OutboundLinkCoverageState::Complete,
                    reason: None,
                    anchors_inspected: 1,
                },
                targets: vec![OutboundLinkTarget {
                    artifact_id: "work:work.example/2".into(),
                    artifact_type: "work.item".into(),
                    url: "https://work.example/items/2?utm_source=removed-secret#fragment".into(),
                    label: Some("Target".into()),
                }],
            },
        }
    }

    fn store(&self) -> CaptureStore {
        CaptureStore::open_in(
            self.config.snapshot().storage.as_ref().unwrap(),
            self.config.root_identity(),
            self.config.dir().unwrap(),
        )
        .unwrap()
    }

    fn save_source(&self, batch: bool) -> PathBuf {
        let store = self.store();
        let origins = self.config.capture_origins();
        let policy = crate::capture::CapturePolicy {
            enabled: true,
            origins: &origins,
            strip_params: &self.config.snapshot().strip_params,
        };
        let result = if batch {
            store
                .record_batch(
                    policy,
                    &uuid::Uuid::new_v4().to_string(),
                    &[crate::capture::CaptureBatchEvent::Activity(&self.source)],
                    None,
                )
                .events
                .remove(0)
                .1
        } else {
            store.record_activity(policy, &self.source)
        };
        match result {
            CaptureOutcome::Persisted { relative_path } => self.root.join(relative_path),
            other => panic!("source failed: {other:?}"),
        }
    }

    fn send(&mut self, request: RecordOutboundLinksRequest) -> OutboundLinksRecorded {
        match record(request, &mut self.config) {
            Response::OutboundLinksRecorded(reply) => reply,
            other => panic!("unexpected reply: {other:?}"),
        }
    }

    fn edit_config(&mut self, from: &str, to: &str) {
        let path = self.folder.path().join("config.toml");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains(from));
        std::fs::write(path, body.replace(from, to)).unwrap();
        self.config.refresh().unwrap();
    }

    fn index(&self) -> crate::index::ArtifactIndex {
        crate::index::ArtifactIndex::open_in(
            self.config.snapshot().storage.as_ref().unwrap(),
            self.config.root_identity(),
            &self.folder.path().join("test-index"),
        )
        .unwrap()
    }

    fn save_summary(&self) -> (crate::summary::SummaryEvent, PathBuf) {
        let summary = crate::summary::PageSummary {
            read_scope: None,
            overview: None,
            event_id: uuid::Uuid::new_v4().to_string(),
            url: "https://unrecognized.example/page".into(),
            title: "Summary source".into(),
            occurred_at: self.source.occurred_at.clone(),
            document_type: "Page".into(),
            category: "Test".into(),
            importance: ImportanceLevel::Medium,
            summary_path: "summaries/example.summary.md".into(),
            record_key: RecordKey {
                kind: RecordKeyKind::Url,
                value: hex::encode(sha2::Sha256::digest(b"https://unrecognized.example/page")),
            },
            artifact_type: "web.page".into(),
            harness: HarnessId::Codex,
        };
        let (outcome, event) = self.store().record_summary(
            crate::capture::CapturePolicy {
                enabled: false,
                origins: &[],
                strip_params: &self.config.snapshot().strip_params,
            },
            &summary,
        );
        let CaptureOutcome::Persisted { relative_path } = outcome else {
            panic!("{outcome:?}")
        };
        (event.unwrap(), self.root.join(relative_path))
    }
}

#[test]
fn outbound_links_bind_single_and_batch_sources_and_replay_without_raw_values() {
    for batch in [false, true] {
        let mut f = Fixture::new();
        let log = f.save_source(batch);
        if batch {
            let text = std::fs::read_to_string(&log).unwrap();
            std::fs::write(&log, text.replace('\n', "\r\n")).unwrap();
        }
        let request = f.request();
        assert_eq!(f.send(request.clone()).outcome, VisitOutcome::Persisted);
        assert_eq!(f.send(request).reason.as_deref(), Some("duplicate_event"));
        let text = std::fs::read_to_string(log).unwrap();
        assert_eq!(text.matches("kind=links_to").count(), 1);
        assert!(!text.contains("removed-secret"));
    }
}

#[test]
fn outbound_links_validate_all_targets_before_home_io_and_preserve_sources() {
    let mut f = Fixture::new();
    let log = f.save_source(false);
    let before = std::fs::read(&log).unwrap();
    let mut request = f.request();
    request.observation.targets[0].artifact_id = "forged".into();
    assert_eq!(
        f.send(request).reason.as_deref(),
        Some("link_target_identity_mismatch")
    );
    assert_eq!(std::fs::read(log).unwrap(), before);
    let mut request = f.request();
    request.observation.targets[0].url = "https://unknown.example/items/2".into();
    std::fs::remove_dir_all(&f.root).unwrap();
    assert_eq!(
        prepare(&f.config, &request).err(),
        Some("link_target_not_allowed")
    );
}

#[test]
fn outbound_links_refuse_missing_torn_conflicting_and_mismatched_source_evidence() {
    for fault in [
        "missing",
        "torn",
        "malformed",
        "conflicting",
        "wrong_kind",
        "wrong_day",
        "wrong_url",
        "unowned",
    ] {
        let mut f = Fixture::new();
        let log = f.save_source(true);
        let mut request = f.request();
        let mut text = std::fs::read_to_string(&log).unwrap();
        match fault {
            "missing" => request.observation.source.event_id = uuid::Uuid::new_v4().to_string(),
            "torn" => {
                text.truncate(text.len() - 8);
            }
            "malformed" => text = text.replace("kind=activity", "kind=unknown"),
            "conflicting" => {
                let marker = text
                    .lines()
                    .find(|line| line.contains("kind=activity"))
                    .unwrap();
                let (start, data) = marker.split_once(" data=").unwrap();
                let (data, tail) = data.split_once(' ').unwrap();
                let mut event: ActivityEvent =
                    serde_json::from_slice(&hex::decode(data).unwrap()).unwrap();
                event.opens += 1;
                let rival = format!(
                    "{start} data={} {tail}\n",
                    hex::encode(serde_json::to_vec(&event).unwrap())
                );
                text.push_str(&rival);
            }
            "wrong_kind" => request.observation.source.kind = OutboundLinkSourceKind::Summary,
            "wrong_day" => {
                let at = crate::capture::parse_event_time(&request.observation.source.occurred_at)
                    .unwrap()
                    - time::Duration::days(1);
                let at = at
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap();
                request.observation.source.occurred_at = at.clone();
                request.observation.observed_at = at;
            }
            "wrong_url" => {
                request.observation.source.url = "https://work.example/items/3".into();
                request.observation.document_url = request.observation.source.url.clone();
            }
            "unowned" => text = text.replacen("daily-log", "user-log", 1),
            _ => unreachable!(),
        }
        std::fs::write(&log, &text).unwrap();
        let result = f.send(request);
        assert_eq!(
            result.reason.as_deref(),
            Some("link_source_not_found"),
            "{fault}: {result:?}"
        );
        assert_eq!(std::fs::read_to_string(log).unwrap(), text, "{fault}");
    }
}

#[test]
fn outbound_links_pause_blocks_activity_but_saved_summary_keeps_its_source_authority() {
    let mut f = Fixture::new();
    f.save_source(false);
    let old = f.request();
    let (summary, log) = f.save_summary();
    f.edit_config("capture_enabled = true", "capture_enabled = false");
    assert_eq!(f.send(old).reason.as_deref(), Some("link_policy_changed"));
    let current = f.request();
    assert_eq!(f.send(current).reason.as_deref(), Some("capture_disabled"));
    let mut request = f.request();
    request.observation.source = OutboundLinkSource {
        kind: OutboundLinkSourceKind::Summary,
        event_id: summary.event_id.clone(),
        occurred_at: summary.occurred_at.clone(),
        url: summary.url.clone(),
    };
    request.observation.document_url = summary.url;
    assert_eq!(f.send(request).outcome, VisitOutcome::Persisted);
    let text = std::fs::read_to_string(log).unwrap();
    let checked = text.lines().find_map(crate::capture::links_marker).unwrap();
    assert_eq!(checked.record.source_artifact_id, summary.artifact_id);
    assert_eq!(checked.record.source_artifact_type, "web.page");
}

#[test]
fn outbound_links_current_target_rules_and_durable_source_identity_are_independent() {
    let mut f = Fixture::new();
    let log = f.save_source(false);
    f.edit_config("id = \"work:{host}/{id}\"", "id = \"changed:{host}/{id}\"");
    let mut request = f.request();
    request.observation.targets[0].artifact_id = "changed:work.example/2".into();
    assert_eq!(
        f.send(request).reason.as_deref(),
        Some("link_source_identity_changed")
    );
    assert_eq!(
        std::fs::read_to_string(log)
            .unwrap()
            .matches("kind=activity")
            .count(),
        1
    );

    // A summary's source can remain authorized even after its source rule is
    // removed; that does not authorize any disabled or out-of-scope target.
    for policy in ["disabled", "scope"] {
        let mut f = Fixture::new();
        let (summary, _) = f.save_summary();
        let mut request = f.request();
        request.observation.source.kind = OutboundLinkSourceKind::Summary;
        request.observation.source.event_id = summary.event_id.clone();
        request.observation.source.url = summary.url.clone();
        request.observation.document_url = summary.url.clone();
        if policy == "scope" {
            f.edit_config(
                "id = \"work:{host}/{id}\"",
                "id = \"work:{host}/{id}\"\nscope = { id = [\"1\"] }",
            );
        } else {
            f.edit_config(
                "[[artifacts]]\ntype = \"work.item\"\norigin = \"https://work.example\"\nmatch = [{path = \"/items/{id:int}\"}]\nid = \"work:{host}/{id}\"\n",
                "",
            );
        }
        request.observation.policy_revision = f.config.revision().into();
        assert_eq!(
            f.send(request).reason.as_deref(),
            Some("link_target_not_allowed")
        );
    }
}

#[test]
fn outbound_links_deduplicate_remove_self_and_distinguish_all_coverage_states() {
    let mut f = Fixture::new();
    let log = f.save_source(false);
    let mut request = f.request();
    let mut first = request.observation.targets[0].clone();
    first.label = None;
    request.observation.targets.insert(0, first);
    request.observation.targets.push(OutboundLinkTarget {
        artifact_id: f.source.artifact_id.clone(),
        artifact_type: f.source.artifact_type.clone(),
        url: format!("{}#self", f.source.url),
        label: None,
    });
    request.observation.coverage.anchors_inspected = 3;
    assert_eq!(f.send(request).outcome, VisitOutcome::Persisted);
    let text = std::fs::read_to_string(&log).unwrap();
    let checked = text.lines().find_map(crate::capture::links_marker).unwrap();
    assert_eq!(checked.record.observation.targets.len(), 1);
    assert_eq!(
        checked.record.observation.targets[0].label.as_deref(),
        Some("Target")
    );
    assert_eq!(
        checked.record.observation.targets[0].url,
        "https://work.example/items/2"
    );
    assert_eq!(
        checked.provenance.targets,
        vec![vec!["utm_source".to_string()]]
    );
    for state in [
        OutboundLinkCoverageState::Complete,
        OutboundLinkCoverageState::Partial,
        OutboundLinkCoverageState::Unavailable,
    ] {
        let mut request = f.request();
        request.observation.targets.clear();
        request.observation.coverage.state = state;
        request.observation.coverage.reason = (state != OutboundLinkCoverageState::Complete)
            .then_some(OutboundLinkReason::DocumentUnavailable);
        assert_eq!(f.send(request).outcome, VisitOutcome::Persisted);
    }
    let text = std::fs::read_to_string(log).unwrap();
    let states: Vec<_> = text
        .lines()
        .filter_map(crate::capture::links_marker)
        .map(|checked| checked.record.observation.coverage.state)
        .collect();
    assert_eq!(states.len(), 4);
    assert_eq!(
        &states[1..],
        &[
            OutboundLinkCoverageState::Complete,
            OutboundLinkCoverageState::Partial,
            OutboundLinkCoverageState::Unavailable
        ]
    );
}

#[test]
fn outbound_links_strict_history_retains_nested_names_and_never_creates_target_activity() {
    let mut f = Fixture::new();
    let log = f.save_source(false);
    let index = f.index();
    let (before, _) = index.relearn_evidence().unwrap();
    let request = f.request();
    assert_eq!(f.send(request).outcome, VisitOutcome::Persisted);
    let (after, evidence) = index.relearn_evidence().unwrap();
    assert_ne!(before, after);
    assert!(
        evidence
            .iter()
            .any(|(key, url)| key.value == "work:work.example/2"
                && url.url == "https://work.example/items/2"
                && url.stripped_params == Some(vec!["utm_source".into()]))
    );
    index.reconcile_from_logs().unwrap();
    assert!(index.artifact("work:work.example/2").unwrap().is_none());
    assert!(
        index
            .artifact_url_evidence("work:work.example/2")
            .unwrap()
            .is_empty(),
        "ordinary cached reads stay inactive until the index projection lane"
    );
    let text = std::fs::read_to_string(&log).unwrap();
    let marker = text
        .lines()
        .find(|line| line.contains("kind=links_to"))
        .unwrap();
    let checked = crate::capture::links_marker(marker).unwrap();
    let mut corrupted = checked.clone();
    corrupted.provenance.targets.clear();
    assert!(!corrupted.valid());
    corrupted = checked.clone();
    corrupted.record.observation.targets[0]
        .url
        .push_str("?utm_source=revived");
    assert!(!corrupted.valid());
    std::fs::write(log, text.replace("kind=links_to", "kind=links_to_broken")).unwrap();
    assert!(
        format!("{:#}", index.relearn_evidence().unwrap_err()).contains("damaged owned log marker")
    );
}

#[test]
fn outbound_links_delivery_time_distinguishes_activity_buckets_and_queued_summaries() {
    let mut f = Fixture::new();
    f.save_source(false);
    let mut request = f.request();
    let source_at = crate::capture::parse_event_time(&f.source.occurred_at).unwrap();
    let shown = |at: time::OffsetDateTime| {
        at.format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    };
    request.observation.observed_at = shown(source_at + time::Duration::seconds(3599));
    assert_eq!(f.send(request.clone()).outcome, VisitOutcome::Persisted);
    request.observation.observation_id = uuid::Uuid::new_v4().to_string();
    request.observation.observed_at = shown(source_at + time::Duration::hours(1));
    assert_eq!(
        f.send(request.clone()).reason.as_deref(),
        Some("link_source_time_mismatch")
    );
    request.observation.observed_at = shown(source_at - time::Duration::seconds(1));
    assert_eq!(
        f.send(request).reason.as_deref(),
        Some("link_source_time_mismatch")
    );
    let (summary, log) = f.save_summary();
    let mut request = f.request();
    request.observation.source = OutboundLinkSource {
        kind: OutboundLinkSourceKind::Summary,
        event_id: summary.event_id,
        occurred_at: summary.occurred_at,
        url: summary.url.clone(),
    };
    request.observation.document_url = summary.url;
    request.observation.observed_at = shown(source_at - time::Duration::hours(3));
    let frozen = request.clone();
    assert_eq!(f.send(request.clone()).outcome, VisitOutcome::Persisted);
    assert_eq!(
        f.send(frozen.clone()).reason.as_deref(),
        Some("duplicate_event")
    );
    let checked = std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .filter_map(crate::capture::links_marker)
        .find(|checked| {
            checked.record.observation.observation_id == frozen.observation.observation_id
        })
        .unwrap();
    assert_eq!(
        checked.record.observation.observed_at,
        frozen.observation.observed_at
    );
    request.observation.observation_id = uuid::Uuid::new_v4().to_string();
    request.observation.observed_at = shown(source_at + time::Duration::seconds(1));
    assert_eq!(
        f.send(request.clone()).reason.as_deref(),
        Some("link_source_time_mismatch")
    );
    for expired in ["source", "observation"] {
        let mut request = frozen.clone();
        let old = shown(source_at - time::Duration::days(31));
        if expired == "source" {
            request.observation.source.occurred_at = old;
        } else {
            request.observation.observed_at = old;
        }
        assert_eq!(
            f.send(request).reason.as_deref(),
            Some("invalid_link_timestamp")
        );
    }
    let mut old = checked;
    old.record.observation.source.occurred_at = shown(source_at - time::Duration::days(90));
    old.record.observation.observed_at = shown(source_at - time::Duration::days(91));
    assert!(
        old.valid(),
        "stored historical replay must not consult today's clock"
    );
}

#[test]
fn outbound_links_reject_invalid_evidence_and_encoded_bounds_before_home_io() {
    let f = Fixture::new();
    let base = f.request();
    std::fs::remove_dir(&f.root).unwrap();
    let mut invalid = Vec::new();
    let mut r = base.clone();
    r.observation.targets = vec![base.observation.targets[0].clone(); 101];
    invalid.push(r);
    let mut r = base.clone();
    r.observation.coverage.anchors_inspected = 501;
    invalid.push(r);
    let mut r = base.clone();
    r.observation.targets[0].label = Some("x".repeat(257));
    invalid.push(r);
    let mut r = base.clone();
    r.observation.targets[0].url = format!("https://work.example/items/2?x={}", "😀".repeat(1500));
    invalid.push(r);
    let mut r = base.clone();
    r.observation.targets[0].artifact_type = "forged.type".into();
    invalid.push(r);
    let mut r = base.clone();
    r.observation.source.event_id = "../source".into();
    invalid.push(r);
    let mut r = base.clone();
    r.observation.policy_revision.push('x');
    invalid.push(r);
    let mut r = base.clone();
    r.observation.frame_id = 2;
    invalid.push(r);
    let mut r = base.clone();
    r.observation.coverage.state = OutboundLinkCoverageState::Unavailable;
    invalid.push(r);
    for url in [
        "javascript:alert(1)",
        "data:text/html,x",
        "file:///tmp/example",
        "mailto:a@example.com",
        "https://user:pass@work.example/items/2",
    ] {
        let mut r = base.clone();
        r.observation.targets[0].url = url.into();
        invalid.push(r);
    }
    let mut r = base;
    r.observation.coverage.anchors_inspected = 100;
    r.observation.targets = (2..102)
        .map(|id| OutboundLinkTarget {
            artifact_id: format!("work:work.example/{id}"),
            artifact_type: "work.item".into(),
            url: format!("https://work.example/items/{id}"),
            label: Some("\u{1}".repeat(256)),
        })
        .collect();
    assert!(serde_json::to_vec(&r).unwrap().len() > MAX_OBSERVATION_BYTES);
    invalid.push(r);
    for (i, request) in invalid.iter().enumerate() {
        assert!(prepare(&f.config, request).is_err(), "case {i}");
    }
    assert!(!f.root.exists());
}

#[test]
fn outbound_links_conflicting_ids_refuse_and_interrupted_appends_recover_exact_bytes() {
    use std::io::Write;
    let mut f = Fixture::new();
    let log = f.save_source(true);
    let request = f.request();
    assert_eq!(f.send(request.clone()).outcome, VisitOutcome::Persisted);
    let complete = std::fs::read(&log).unwrap();
    let source_len = std::str::from_utf8(&complete)
        .unwrap()
        .find("\n- ")
        .unwrap();
    let start = std::str::from_utf8(&complete).unwrap()[source_len + 1..]
        .find("\n- ")
        .unwrap()
        + source_len
        + 1;
    std::fs::write(&log, &complete[..start + (complete.len() - start) / 2]).unwrap();
    assert_eq!(f.send(request.clone()).outcome, VisitOutcome::Persisted);
    assert_eq!(std::fs::read(&log).unwrap(), complete);
    let mut conflict = request.clone();
    conflict.observation.targets[0].label = Some("Different".into());
    assert_eq!(
        f.send(conflict).reason.as_deref(),
        Some("link_observation_id_conflict")
    );
    // Source reuse changes the reference even when all target bytes agree.
    let mut another = f.source.clone();
    another.event_id = uuid::Uuid::new_v4().to_string();
    f.source = another;
    f.save_source(true);
    let mut conflict = f.request();
    conflict.observation.observation_id = request.observation.observation_id.clone();
    assert_eq!(
        f.send(conflict).reason.as_deref(),
        Some("link_observation_id_conflict")
    );
    let mut collision = f.request();
    // The earlier activity was in a compact batch, without its own journal.
    collision.observation.observation_id = request.observation.source.event_id;
    assert_eq!(
        f.send(collision).reason.as_deref(),
        Some("link_observation_id_conflict")
    );
    // Strict readers retain conflicts even if somebody edits owned evidence.
    let marker = std::str::from_utf8(&complete)
        .unwrap()
        .lines()
        .find(|line| line.contains("kind=links_to"))
        .unwrap();
    let mut checked = crate::capture::links_marker(marker).unwrap();
    checked.record.observation.targets[0].label = Some("Conflicting durable body".into());
    let (prefix, rest) = marker.split_once(" data=").unwrap();
    let (_, suffix) = rest.split_once(' ').unwrap();
    let mut file = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
    writeln!(
        file,
        "{prefix} data={} {suffix}",
        hex::encode(serde_json::to_vec(&checked.record).unwrap())
    )
    .unwrap();
    assert!(
        f.index()
            .relearn_evidence()
            .unwrap_err()
            .to_string()
            .contains("conflicting recorded event IDs")
    );
}

#[test]
fn outbound_links_unicode_and_escaping_fit_frames_entries_and_journals() {
    let mut f = Fixture::new();
    let log = f.save_source(false);
    let mut request = f.request();
    request.observation.coverage.anchors_inspected = 500;
    request.observation.targets = (2..102)
        .map(|id| OutboundLinkTarget {
            artifact_id: format!("work:work.example/{id}"),
            artifact_type: "work.item".into(),
            url: format!("https://work.example/items/{id}?keep=\\\"&utm_source=removed-secret"),
            label: Some(format!("{}{}", "😀".repeat(64), "\"\\".repeat(32))),
        })
        .collect();
    let bytes = serde_json::to_vec(&request).unwrap();
    assert!(bytes.len() <= MAX_OBSERVATION_BYTES);
    assert!(bytes.len() + 4 < 4 * 1024 * 1024);
    let reply = f.send(request.clone());
    assert_eq!(reply.outcome, VisitOutcome::Persisted);
    assert!(
        serde_json::to_vec(&Response::OutboundLinksRecorded(reply))
            .unwrap()
            .len()
            + 4
            < 900 * 1024
    );
    let hash = hex::encode(sha2::Sha256::digest(
        request.observation.observation_id.as_bytes(),
    ));
    let journal = f
        .config
        .dir()
        .unwrap()
        .join("visit-ids")
        .join(&hash[..2])
        .join(format!("{hash}.json"));
    let bytes = std::fs::read(journal).unwrap();
    assert!(bytes.len() < 1024 * 1024);
    let intent: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(intent["entry"].as_str().unwrap().len() < 512 * 1024);
    let text = std::fs::read_to_string(log).unwrap();
    let checked = text.lines().find_map(crate::capture::links_marker).unwrap();
    assert!(checked.valid());
    assert_eq!(checked.record.observation.targets.len(), 100);
    assert!(!String::from_utf8(bytes).unwrap().contains("removed-secret"));
}

#[test]
fn outbound_links_inherit_removed_source_names_and_preserve_legacy_unknown() {
    for legacy in [false, true] {
        let mut f = Fixture::new();
        f.source.url.push_str("?utm_source=removed-source-secret");
        let log = f.save_source(false);
        if legacy {
            let text = std::fs::read_to_string(&log).unwrap();
            let (start, rest) = text.split_once(" stripped=").unwrap();
            let (_, end) = rest.split_once(" -->").unwrap();
            std::fs::write(&log, format!("{start} -->{end}")).unwrap();
        }
        let mut request = f.request();
        request.observation.source.url = "https://work.example/items/1".into();
        request.observation.document_url = request.observation.source.url.clone();
        assert_eq!(f.send(request).outcome, VisitOutcome::Persisted);
        let text = std::fs::read_to_string(log).unwrap();
        let checked = text.lines().find_map(crate::capture::links_marker).unwrap();
        let source = checked.evidence().remove(0).2;
        assert_eq!(
            source.stripped_params,
            (!legacy).then(|| vec!["utm_source".into()])
        );
        assert_eq!(checked.provenance.source_unknown, legacy);
        assert!(
            !serde_json::to_string(&checked)
                .unwrap()
                .contains("removed-source-secret")
        );
    }
}

#[test]
fn outbound_links_enrichment_io_failure_preserves_source_and_exact_retry_remains_possible() {
    let mut f = Fixture::new();
    let log = f.save_source(false);
    let before = std::fs::read(&log).unwrap();
    let request = f.request();
    let hash = hex::encode(sha2::Sha256::digest(
        request.observation.observation_id.as_bytes(),
    ));
    let journal = f
        .config
        .dir()
        .unwrap()
        .join("visit-ids")
        .join(&hash[..2])
        .join(format!("{hash}.json"));
    std::fs::create_dir_all(&journal).unwrap();
    assert_eq!(f.send(request.clone()).outcome, VisitOutcome::Retryable);
    assert_eq!(std::fs::read(&log).unwrap(), before);
    std::fs::remove_dir(journal).unwrap();
    assert_eq!(f.send(request).outcome, VisitOutcome::Persisted);
    assert!(std::fs::read(log).unwrap().starts_with(&before));
    let mut f = Fixture::new();
    let request = f.request();
    assert_eq!(
        f.send(request).reason.as_deref(),
        Some("link_source_not_found")
    );
    assert_eq!(std::fs::read_dir(f.root).unwrap().count(), 0);
}

#[test]
fn outbound_links_selected_document_context_is_never_an_artifact_alias() {
    let mut f = Fixture::new();
    let log = f.save_source(false);
    let mut request = f.request();
    request.observation.frame_scope = OutboundLinkFrameScope::SelectedDocument;
    request.observation.frame_id = 7;
    request.observation.document_url =
        "https://frame.example/reader?utm_source=removed-frame-secret".into();
    assert_eq!(f.send(request).outcome, VisitOutcome::Persisted);
    let text = std::fs::read_to_string(log).unwrap();
    let checked = text.lines().find_map(crate::capture::links_marker).unwrap();
    assert_eq!(
        checked.record.observation.document_url,
        "https://frame.example/reader"
    );
    assert_eq!(checked.provenance.document, Some(vec!["utm_source".into()]));
    assert!(
        !f.index()
            .relearn_evidence()
            .unwrap()
            .1
            .iter()
            .any(|(_, url)| url.url.contains("frame.example"))
    );
}

#[test]
fn outbound_links_native_frames_use_the_separate_admission_without_a_service() {
    let f = Fixture::new();
    f.save_source(true);
    let mut input = Vec::new();
    crate::frame::write_request(&mut input, &Request::RecordOutboundLinks(f.request())).unwrap();
    let config = ConfigStore::for_test(f.folder.path().join("config.toml"));
    let mut output = Vec::new();
    crate::native::serve_with_context(
        &input[..],
        &mut output,
        config,
        &crate::native::SetupContext::new(),
    )
    .unwrap();
    let bytes = crate::frame::read_frame(&mut &output[..]).unwrap().unwrap();
    let Response::OutboundLinksRecorded(reply) = serde_json::from_slice(&bytes).unwrap() else {
        panic!("expected independent observation response");
    };
    assert_eq!(reply.outcome, VisitOutcome::Persisted);
}

#[test]
fn outbound_links_raw_encoded_frames_and_invalid_id_replies_are_bounded() {
    let mut f = Fixture::new();
    let mut request = f.request();
    request.observation.coverage.anchors_inspected = 100;
    let mut target = request.observation.targets[0].clone();
    target.label = Some("😀".repeat(64));
    request.observation.targets = vec![target; 100];
    let bytes = serde_json::to_vec(&Request::RecordOutboundLinks(request.clone())).unwrap();
    assert!(bytes.len() < MAX_OBSERVATION_BYTES);
    let escaped = String::from_utf8(bytes.clone())
        .unwrap()
        .replace('😀', "\\ud83d\\ude00");
    assert!(escaped.len() > MAX_OBSERVATION_BYTES);
    let Err(Response::Error(reply)) = crate::native::parse_envelope(escaped.as_bytes()) else {
        panic!("raw encoded observation must be bounded before dispatch");
    };
    assert_eq!(reply.code, ErrorCode::MessageTooLarge);
    let mut padded = bytes;
    padded.resize(MAX_OBSERVATION_BYTES + 1, b' ');
    assert!(matches!(
        crate::native::parse_envelope(&padded),
        Err(Response::Error(ErrorResponse {
            code: ErrorCode::MessageTooLarge,
            ..
        }))
    ));
    request.observation.observation_id = "invalid".repeat(100_000);
    let response = record(request, &mut f.config);
    assert!(matches!(
        &response,
        Response::Error(ErrorResponse {
            code: ErrorCode::InvalidRequest,
            ..
        })
    ));
    assert!(serde_json::to_vec(&response).unwrap().len() < 1024);
    assert_eq!(std::fs::read_dir(f.root).unwrap().count(), 0);
}
