use super::*;
use brauser_protocol::{
    ExplorerConnectionBasis as Basis, ExplorerConnectionDirection as Direction,
    ExplorerReadingFilter as Reading, RecentPageRequest,
};

fn filters() -> ExplorerFilters<'static> {
    ExplorerFilters {
        query: None,
        source: None,
        artifact_type: None,
        category: None,
        document_type: None,
        reading: None,
        limit: 8,
    }
}
fn first() -> RecentPageRequest {
    RecentPageRequest {
        offset: 0,
        snapshot: None,
    }
}
fn summary(
    index: &ArtifactIndex,
    event: &ActivityEvent,
    category: &str,
    read: Option<crate::answer::ReadScope>,
) -> SummaryEvent {
    let mut summary = adapter_summary(
        &event.artifact_id,
        &event.artifact_type,
        &event.url,
        &event.occurred_at,
    );
    summary.title = event.title.clone().unwrap_or_default();
    summary.category = category.into();
    summary.overview = Some("A useful overview about Rückblick".into());
    summary.read_scope = read;
    index.record_summary(&summary).unwrap();
    summary
}

#[test]
fn explorer_is_unique_uses_latest_summary_and_searches_unicode_context() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    let a = activity(
        &Uuid::new_v4().to_string(),
        "A",
        "Überblick",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-15T10:00:00Z",
    );
    let mut again = a.clone();
    again.event_id = Uuid::new_v4().to_string();
    // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
    again.occurred_at = "2026-10-16T10:00:00Z".into();
    index.record_activities([&a, &again], &[]).unwrap();
    summary(&index, &a, "Quality", None);
    let newest = summary(
        &index,
        &again,
        "Operations",
        Some(crate::answer::ReadScope::Whole),
    );
    let result = index.explore(filters(), "r", &first()).unwrap();
    assert_eq!(
        (result.total, result.library_total, result.items.len()),
        (1, 1, 1)
    );
    assert_eq!(result.items[0].summary, Some(expected_view(&newest)));
    assert_eq!(result.items[0].source, "example.com");
    // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
    assert_eq!(result.items[0].first_seen, "2026-10-15");
    // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
    assert_eq!(result.items[0].last_seen, "2026-10-16");
    for query in [
        "ÜBER",
        "RÜCKBLICK",
        "EXAMPLE.COM",
        "ÜBER RÜCKBLICK EXAMPLE.COM",
    ] {
        let mut f = filters();
        f.query = Some(query);
        assert_eq!(index.explore(f, "r", &first()).unwrap().total, 1, "{query}");
    }
    let mut f = filters();
    f.category = Some("Quality");
    let result = index.explore(f, "r", &first()).unwrap();
    assert_eq!(result.total, 0);
    assert_eq!(result.facets.categories[0].value, "Operations");
    index
        .record_why(
            &WhyEvent {
                event_id: Uuid::new_v4().to_string(),
                artifact_id: a.artifact_id,
                url: a.url,
                // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
                occurred_at: "2026-10-16T11:00:00Z".into(),
                incognito: false,
                text: "Personal retrieval clue".into(),
            },
            &[],
        )
        .unwrap();
    let mut f = filters();
    f.query = Some("RETRIEVAL CLUE");
    assert_eq!(index.explore(f, "r", &first()).unwrap().total, 1);
}

#[test]
fn explorer_filters_before_paging_and_binds_full_result_facets_and_scope() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    for n in 0..35 {
        let event = activity(
            &Uuid::new_v4().to_string(),
            &n.to_string(),
            &format!("Document {n:02}"),
            // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
            "2026-10-15T10:00:00Z",
        );
        index.record_activity(&event, &[]).unwrap();
        summary(
            &index,
            &event,
            if n % 2 == 0 { "Quality" } else { "Operations" },
            None,
        );
    }
    let mut f = filters();
    f.category = Some("Quality");
    let one = index.explore(f, "r", &first()).unwrap();
    assert_eq!((one.total, one.library_total, one.items.len()), (18, 35, 8));
    assert_eq!(
        one.facets
            .categories
            .iter()
            .map(|f| (&*f.value, f.count))
            .collect::<Vec<_>>(),
        [("Operations", 17), ("Quality", 18)]
    );
    let mut ids = BTreeSet::new();
    ids.extend(one.items.iter().map(|i| i.artifact_id.clone()));
    let mut offset = one.page.next_offset;
    while let Some(next) = offset {
        let mut f = filters();
        f.category = Some("Quality");
        let result = index
            .explore(
                f,
                "r",
                &RecentPageRequest {
                    offset: next,
                    snapshot: Some(one.page.snapshot.clone()),
                },
            )
            .unwrap();
        for item in result.items {
            assert!(ids.insert(item.artifact_id));
        }
        offset = result.page.next_offset;
    }
    assert_eq!(ids.len(), 18);
    let resume = RecentPageRequest {
        offset: 8,
        snapshot: Some(one.page.snapshot.clone()),
    };
    assert!(index.explore(filters(), "r", &resume).is_err());
    let mut f = filters();
    f.category = Some("Quality");
    assert!(index.explore(f, "new-config", &resume).is_err());
    let second_root = TempDir::new().unwrap();
    let second_cache = TempDir::new().unwrap();
    let other = super::index(&second_root, &second_cache);
    let mut f = filters();
    f.category = Some("Quality");
    assert!(other.explore(f, "r", &resume).is_err());
    let event = activity(
        &Uuid::new_v4().to_string(),
        "other",
        "Other",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-16T10:00:00Z",
    );
    index.record_activity(&event, &[]).unwrap(); // outside category still changes complete library facets
    let mut f = filters();
    f.category = Some("Quality");
    assert!(index.explore(f, "r", &resume).is_err());
    assert!(
        index
            .explore(
                filters(),
                "r",
                &RecentPageRequest {
                    offset: 1,
                    snapshot: None
                }
            )
            .is_err()
    );
}

#[test]
fn explorer_reading_distinguishes_unsummarized_unknown_and_partial() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    for (n, scope) in [
        None,
        Some(None),
        Some(Some(crate::answer::ReadScope::Whole)),
        Some(Some(crate::answer::ReadScope::Partial)),
        Some(Some(crate::answer::ReadScope::PageOnly)),
    ]
    .into_iter()
    .enumerate()
    {
        let event = activity(
            &Uuid::new_v4().to_string(),
            &n.to_string(),
            "Artifact",
            // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
            "2026-10-15T10:00:00Z",
        );
        index.record_activity(&event, &[]).unwrap();
        if let Some(scope) = scope {
            summary(&index, &event, "Quality", scope);
        }
    }
    for (reading, count) in [
        (None, 5),
        (Some(Reading::None), 1),
        (Some(Reading::Unknown), 1),
        (Some(Reading::Whole), 1),
        (Some(Reading::Limited), 2),
    ] {
        let mut f = filters();
        f.reading = reading;
        assert_eq!(index.explore(f, "r", &first()).unwrap().total, count);
    }
}

#[test]
fn explorer_context_has_direction_explanations_unique_neighbors_and_honest_caps() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    let center = activity(
        &Uuid::new_v4().to_string(),
        "center",
        "Center",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-15T10:00:00Z",
    );
    index.record_activity(&center, &[]).unwrap();
    summary(&index, &center, "Quality", None);
    let incoming = activity(
        &Uuid::new_v4().to_string(),
        "incoming",
        "Incoming",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-15T10:00:00Z",
    );
    index.record_activity(&incoming, &[]).unwrap();
    let mut next = center.clone();
    next.event_id = Uuid::new_v4().to_string();
    // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
    next.occurred_at = "2026-10-16T10:00:00Z".into();
    next.trails = vec![
        ActivityTrail {
            from_artifact_id: Some(incoming.artifact_id.clone()),
            from_url: Some(incoming.url.clone()),
            transition: "link".into(),
        },
        ActivityTrail {
            from_artifact_id: Some(center.artifact_id.clone()),
            from_url: Some(center.url.clone()),
            transition: "link".into(),
        },
    ];
    index.record_activity(&next, &[]).unwrap();
    let mut outgoing = activity(
        &Uuid::new_v4().to_string(),
        "outgoing",
        "Outgoing",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-16T10:00:00Z",
    );
    outgoing.trails = ["link", "form_submit"]
        .into_iter()
        .map(|transition| ActivityTrail {
            from_artifact_id: Some(center.artifact_id.clone()),
            from_url: Some(center.url.clone()),
            transition: transition.into(),
        })
        .collect();
    outgoing.refs.push(ActivityRef {
        artifact_type: "work.item".into(),
        value: "MISSING".into(),
    });
    index.record_activity(&outgoing, &[]).unwrap();
    summary(&index, &outgoing, "Quality", None);
    for n in 0..10 {
        let event = activity(
            &Uuid::new_v4().to_string(),
            &n.to_string(),
            "Same category",
            // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
            "2026-10-15T10:00:00Z",
        );
        index.record_activity(&event, &[]).unwrap();
        summary(&index, &event, "Quality", None);
    }
    let result = index.artifact_context(&center.artifact_id).unwrap();
    assert_eq!(result.item.unwrap().artifact_id, center.artifact_id);
    assert!(result.truncated);
    assert_eq!(result.connections.len(), 8);
    let find = |id: &str| {
        result
            .connections
            .iter()
            .find(|c| c.artifact.artifact_id == id)
            .unwrap()
    };
    assert_eq!(find(&incoming.artifact_id).direction, Direction::Incoming);
    assert_eq!(find(&outgoing.artifact_id).direction, Direction::Outgoing);
    assert_eq!(find(&outgoing.artifact_id).basis, Basis::Navigation);
    assert_eq!(
        find(&outgoing.artifact_id).last_seen.as_deref(),
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        Some("2026-10-16")
    );
    assert!(
        result
            .connections
            .iter()
            .filter(|c| c.basis == Basis::SameCategory)
            .all(|c| c.direction == Direction::Associated
                && c.transition.is_none()
                && c.last_seen.is_none())
    );
    assert_eq!(
        result
            .connections
            .iter()
            .map(|c| &c.artifact.artifact_id)
            .collect::<BTreeSet<_>>()
            .len(),
        8
    );
    let absent = index.artifact_context("../../not-a-record").unwrap();
    assert!(absent.item.is_none() && absent.connections.is_empty() && !absent.truncated);
}

#[test]
fn explorer_context_preserves_title_mentions_and_containers() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let document = github_document(true);
    let index = index(&root, &cache).with_adapters(Some(&document));
    // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
    let event = github_pr(1, 7, "2026-10-15T10:00:00Z");
    index.record_activity(&event, &[]).unwrap();
    let result = index.artifact_context(&event.artifact_id).unwrap();
    let container = &result.connections[0];
    assert_eq!(container.basis, Basis::Container);
    assert_eq!(container.direction, Direction::Outgoing);
    assert_eq!(container.artifact.artifact_id, GITHUB_REPO_ID);
    let document:adapter_templates::Value=serde_json::from_value(serde_json::json!({"format":1,"artifacts":[{"type":"jira.issue","origin":"https://acme.atlassian.net","match":[{"path":"/browse/{key:jira_key}"}],"id":"jira:{host}/{key}"}]})).unwrap();
    let document = adapter_templates::Document::from_value(&document).unwrap();
    let index = index.with_adapters(Some(&document));
    let mut target = activity(
        &Uuid::new_v4().to_string(),
        "t",
        "Target",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-16T10:00:00Z",
    );
    target.artifact_id = "jira:acme.atlassian.net/PROJ-1".into();
    target.artifact_type = "jira.issue".into();
    target.url = "https://acme.atlassian.net/browse/PROJ-1".into();
    target.modes.clear();
    let mut source = activity(
        &Uuid::new_v4().to_string(),
        "s",
        "PROJ-1 is mentioned",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-16T10:00:00Z",
    );
    source.refs.push(ActivityRef {
        artifact_type: "jira.issue".into(),
        value: "PROJ-1".into(),
    });
    index.record_activities([&source, &target], &[]).unwrap();
    let result = index.artifact_context(&target.artifact_id).unwrap();
    assert_eq!(result.connections[0].basis, Basis::TitleMention);
    assert_eq!(result.connections[0].direction, Direction::Incoming);
    assert!(result.connections[0].transition.is_none());
}

#[test]
fn explorer_reads_unchanged_index_without_writes_or_full_derive() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    let event = activity(
        &Uuid::new_v4().to_string(),
        "a",
        "Artifact",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-15T10:00:00Z",
    );
    // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
    write_log(root.path(), "2026-10-15.md", &[&event]);
    index.record_activity(&event, &[]).unwrap();
    let files_before = fs::read_dir(root.path().join("log")).unwrap().count();
    LOG_BYTES_READ.with(|n| n.set(0));
    TRANSACTIONS.with(|n| n.set(0));
    FULL_DERIVES.with(|n| n.set(0));
    index.explore(filters(), "r", &first()).unwrap();
    index.artifact_context(&event.artifact_id).unwrap();
    assert_eq!(LOG_BYTES_READ.with(std::cell::Cell::get), 0);
    assert_eq!(TRANSACTIONS.with(std::cell::Cell::get), 0);
    assert_eq!(FULL_DERIVES.with(std::cell::Cell::get), 0);
    assert_eq!(
        fs::read_dir(root.path().join("log")).unwrap().count(),
        files_before
    );
    assert!(!root.path().join("artifacts").exists());
}

#[test]
fn explorer_facets_report_truncation_without_counting_rows_twice() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    for n in 0..66 {
        let event = activity(
            &Uuid::new_v4().to_string(),
            &n.to_string(),
            "Artifact",
            // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
            "2026-10-15T10:00:00Z",
        );
        index.record_activity(&event, &[]).unwrap();
        summary(&index, &event, &format!("Category {n:02}"), None);
    }
    let result = index.explore(filters(), "r", &first()).unwrap();
    assert_eq!(result.library_total, 66);
    assert_eq!(result.facets.categories.len(), 64);
    assert!(result.facets.truncated);
    assert_eq!(result.facets.artifact_types[0].count, 66);
}

#[test]
fn explorer_tied_summary_projection_matches_existing_latest_summary_semantics() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    let event = activity(
        &Uuid::new_v4().to_string(),
        "same",
        "Same instant",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-15T10:00:00Z",
    );
    index.record_activity(&event, &[]).unwrap();
    let mut one = adapter_summary(
        &event.artifact_id,
        &event.artifact_type,
        &event.url,
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-15T10:00:00Z",
    );
    one.event_id = "00000000-0000-4000-8000-000000000001".into();
    one.category = "Earlier tie".into();
    let mut two = one.clone();
    two.event_id = "00000000-0000-4000-8000-000000000002".into();
    two.category = "Later tie".into();
    // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
    two.occurred_at = "2026-10-15T03:00:00-07:00".into();
    index.record_summary(&two).unwrap();
    index.record_summary(&one).unwrap();
    let result = index.explore(filters(), "r", &first()).unwrap();
    assert_eq!(
        result.items[0].summary,
        index.summary_for(&event.artifact_id).unwrap()
    );
    assert_eq!(
        result.items[0].summary.as_ref().unwrap().category,
        "Earlier tie"
    );
}

#[test]
fn explorer_saved_facet_values_match_exactly_including_edge_whitespace() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    let event = activity(
        &Uuid::new_v4().to_string(),
        "pad",
        "Padded metadata",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-15T10:00:00Z",
    );
    index.record_activity(&event, &[]).unwrap();
    let mut saved = adapter_summary(
        &event.artifact_id,
        &event.artifact_type,
        &event.url,
        &event.occurred_at,
    );
    saved.category = " Quality ".into();
    saved.document_type = " Report ".into();
    index.record_summary(&saved).unwrap();
    let result = index.explore(filters(), "r", &first()).unwrap();
    assert_eq!(result.facets.categories[0].value, " Quality ");
    assert_eq!(result.facets.document_types[0].value, " Report ");
    let mut exact = filters();
    exact.category = Some(" Quality ");
    exact.document_type = Some(" Report ");
    assert_eq!(index.explore(exact, "r", &first()).unwrap().total, 1);
    let mut trimmed = filters();
    trimmed.category = Some("Quality");
    assert_eq!(index.explore(trimmed, "r", &first()).unwrap().total, 0);
    let mut trimmed = filters();
    trimmed.document_type = Some("Report");
    assert_eq!(index.explore(trimmed, "r", &first()).unwrap().total, 0);
    let mut exact = filters();
    exact.category = Some(" Quality ");
    exact.document_type = Some(" Report ");
    assert_ne!(
        index.explore(exact, "r", &first()).unwrap().page.snapshot,
        result.page.snapshot
    );
}

#[test]
fn explorer_bounds_display_text_without_rewriting_stored_records() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    let title = format!("Visible\u{202e}{}", "T".repeat(100_000));
    let event = activity(
        &Uuid::new_v4().to_string(),
        "large",
        &title,
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-15T10:00:00Z",
    );
    index.record_activity(&event, &[]).unwrap();
    let why = format!("Context\n{}", "W".repeat(100_000));
    index
        .record_why(
            &WhyEvent {
                event_id: Uuid::new_v4().to_string(),
                artifact_id: event.artifact_id.clone(),
                url: event.url.clone(),
                occurred_at: event.occurred_at.clone(),
                incognito: false,
                text: why.clone(),
            },
            &[],
        )
        .unwrap();
    let result = index.explore(filters(), "r", &first()).unwrap();
    let item = &result.items[0];
    assert_eq!(item.title.chars().count(), 2048);
    assert_eq!(item.why.as_ref().unwrap().chars().count(), 500);
    assert!(!item.title.contains('\u{202e}'));
    assert!(!item.why.as_ref().unwrap().contains('\n'));
    let context = index.artifact_context(&event.artifact_id).unwrap();
    assert_eq!(context.item.as_ref().unwrap(), item);
    let stored = index.artifact(&event.artifact_id).unwrap().unwrap();
    assert_eq!(stored.title, title);
    assert_eq!(stored.why.as_deref(), Some(why.as_str()));
}

#[test]
fn explorer_refuses_oversized_authority_values_instead_of_cutting_them() {
    for field in ["id", "type", "url"] {
        let root = TempDir::new().unwrap();
        let cache = TempDir::new().unwrap();
        let index = index(&root, &cache);
        let event = activity(
            &Uuid::new_v4().to_string(),
            "bad",
            "Artifact",
            // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
            "2026-10-15T10:00:00Z",
        );
        index.record_activity(&event, &[]).unwrap();
        let (column, value) = match field {
            "id" => ("artifact_id", "i".repeat(513)),
            "type" => ("artifact_type", "t".repeat(65)),
            _ => ("url", format!("https://example.com/{}", "p".repeat(8200))),
        };
        // Simulate an older/damaged projection without changing log authority.
        let connection = rusqlite::Connection::open(index.database_path()).unwrap();
        connection
            .execute(&format!("UPDATE artifacts SET {column} = ?1"), [&value])
            .unwrap();
        drop(connection);
        assert!(index.explore(filters(), "r", &first()).is_err(), "{field}");
        assert!(
            index.artifact_context(&event.artifact_id).is_err(),
            "{field}"
        );
        assert_eq!(
            sql::sql_rows(
                &index.database_path(),
                &format!("SELECT {column} FROM artifacts")
            )[0][0],
            sql::Value::Text(value)
        );
    }
}

#[test]
fn explorer_refuses_invalid_summary_metadata_without_relabelling_it() {
    let root = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let index = index(&root, &cache);
    let event = activity(
        &Uuid::new_v4().to_string(),
        "bad-summary",
        "Artifact",
        // timing-ok: synthetic log dates order fixture records; no comparison with the real clock.
        "2026-10-15T10:00:00Z",
    );
    index.record_activity(&event, &[]).unwrap();
    let oversized_category = "C".repeat(65);
    summary(&index, &event, &oversized_category, None);
    assert!(index.explore(filters(), "r", &first()).is_err());
    assert!(index.artifact_context(&event.artifact_id).is_err());
    assert_eq!(
        index
            .summary_for(&event.artifact_id)
            .unwrap()
            .unwrap()
            .category,
        oversized_category
    );
    summary(&index, &event, "Quality", None);
    assert_eq!(
        index.explore(filters(), "r", &first()).unwrap().items[0]
            .summary
            .as_ref()
            .unwrap()
            .category,
        "Quality"
    );
}
