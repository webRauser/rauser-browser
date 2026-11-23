//! Compatibility regressions for capture reviews of existing adapter identities.

use std::path::{Path, PathBuf};

use brauser_protocol::CaptureReviewContext;
use serde_json::{Value, json};

use super::{accept, save, tier0};
use crate::config::{ConfigStore, fixtures};

const ORIGIN: &str = "https://tools.example.com";
const ELSEWHERE: &str = "https://elsewhere.example.com";

fn adapter(origin: &str, id: &str, paths: &[&str], title: &str) -> Value {
    json!({
        "type": "work.doc", "origin": origin, "id": id,
        "match": paths.iter().map(|path| json!({"path": path})).collect::<Vec<_>>(),
        "title": title,
    })
}

fn proposal(original: &Value, addition: &str) -> Value {
    let mut candidate = tier0(original);
    candidate["match"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path": addition}));
    candidate
}

fn answer(adapters: Vec<Value>, shapes: &[&str]) -> Value {
    json!({
        "adapters": adapters,
        "review": {
            "status": "validated", "report": "Observed the artifact routes and checked stable identities.",
            "visited": shapes.iter().map(|shape| json!({"shape": shape, "count": 1})).collect::<Vec<_>>(),
            "links": [],
        },
    })
}

fn setup(tables: &[Value], seed: &str) -> (tempfile::TempDir, PathBuf, CaptureReviewContext) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("home");
    std::fs::create_dir(&root).unwrap();
    let path = temp.path().join("config.toml");
    let artifacts = toml::to_string(&json!({"artifacts": tables})).unwrap();
    fixtures::write(
        &path,
        &root,
        "",
        "capture_enabled = false",
        &format!("[adapters]\nformat = 1\n{artifacts}"),
    );
    let store = ConfigStore::load_from(path.clone());
    assert_eq!(store.config_issue(), None);
    assert_eq!(store.adapter_issue(), None);
    let context = CaptureReviewContext {
        start_request_id: "compatibility-capture-review".into(),
        url: seed.into(),
        revision: store.revision().into(),
        visited: vec![],
        links: vec![],
    };
    (temp, path, context)
}

fn tables(path: &Path) -> Vec<Value> {
    ConfigStore::load_from(path.to_path_buf())
        .snapshot()
        .adapters
        .artifacts
        .clone()
}

fn apply(path: &Path, context: &CaptureReviewContext, result: &Value) -> Result<(), String> {
    let origin = url::Url::parse(&context.url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let checked = accept(&result.to_string(), &origin)?;
    save(path, context, &checked)
}

#[test]
fn capture_review_existing_shipped_starter_id_schemes_remain_unchanged() {
    for (source, origin, seed_path, addition, shape, expected_id) in [
        (
            include_str!("../../../protocol/starters/atlassian.json"),
            "https://work.atlassian.net",
            "/browse/WORK-123",
            "/issues/{key:jira_key}",
            "/issues/{key}",
            "jira:work.atlassian.net/WORK-456",
        ),
        (
            include_str!("../../../protocol/starters/sharepoint.json"),
            "https://work.sharepoint.com",
            "/documents/01234567-89ab-4cde-8fab-0123456789ab",
            "/documents/{doc:uuid}",
            "/documents/{uuid}",
            "sharepoint:work.sharepoint.com/01234567-89ab-4cde-8fab-0123456789ab",
        ),
    ] {
        let starter: Value = serde_json::from_str(source).unwrap();
        let mut initial = starter["types"][0]["adapter"].clone();
        initial["origin"] = json!(origin);
        let seed = format!("{origin}{seed_path}");
        let (_temp, path, context) = setup(std::slice::from_ref(&initial), &seed);
        let candidate = proposal(&initial, addition);
        apply(&path, &context, &answer(vec![candidate], &[shape])).unwrap();

        let after = tables(&path);
        assert_eq!(after.len(), 1);
        let mut expected = initial.clone();
        expected["match"]
            .as_array_mut()
            .unwrap()
            .push(json!({"path": addition}));
        assert_eq!(after[0], expected, "{origin}");
        let observed = if origin.ends_with("atlassian.net") {
            format!("{origin}/issues/WORK-456")
        } else {
            seed
        };
        let store = ConfigStore::load_from(path);
        let matched = store
            .adapter_document()
            .unwrap()
            .evaluate(&observed, None)
            .unwrap();
        assert_eq!(matched.artifact_id, expected_id, "{origin}");
    }
}

#[test]
fn capture_review_same_type_on_another_origin_first_stays_untouched() {
    let elsewhere = adapter(
        ELSEWHERE,
        "work.doc:{host}/{id}",
        &["/docs/{id:int}"],
        "{title} · Other site",
    );
    let selected = adapter(
        ORIGIN,
        "work.doc:{host}/{id}",
        &["/docs/{id:int}"],
        "{title} · Selected site",
    );
    let (_temp, path, context) = setup(
        &[elsewhere.clone(), selected.clone()],
        &format!("{ORIGIN}/docs/123"),
    );
    apply(
        &path,
        &context,
        &answer(
            vec![proposal(&selected, "/documents/{id:int}")],
            &["/documents/{num}"],
        ),
    )
    .unwrap();

    let after = tables(&path);
    assert_eq!(after.len(), 2);
    assert_eq!(after[0], elsewhere);
    assert_eq!(after[1]["id"], selected["id"]);
    assert_eq!(after[1]["title"], selected["title"]);
    assert_eq!(after[1]["match"].as_array().unwrap().len(), 2);
}

#[test]
fn capture_review_same_origin_same_type_siblings_with_distinct_ids_both_update() {
    let first = adapter(
        ORIGIN,
        "work.doc:{host}/alpha/{id}",
        &["/alpha/{id:int}"],
        "{title} · Alpha",
    );
    let second = adapter(
        ORIGIN,
        "work.doc:{host}/beta/{id}",
        &["/beta/{id:int}"],
        "{title} · Beta",
    );
    let (_temp, path, context) = setup(
        &[first.clone(), second.clone()],
        &format!("{ORIGIN}/alpha/123"),
    );
    let first_proposal = proposal(&first, "/alpha-docs/{id:int}");
    let second_proposal = proposal(&second, "/beta-docs/{id:int}");
    apply(
        &path,
        &context,
        &answer(
            vec![first_proposal.clone(), second_proposal.clone()],
            &["/alpha-docs/{num}", "/beta-docs/{num}"],
        ),
    )
    .unwrap();

    let after = tables(&path);
    assert_eq!(after.len(), 2);
    for (at, original, proposed) in [(0, first, first_proposal), (1, second, second_proposal)] {
        let mut expected = original;
        expected["match"] = proposed["match"].clone();
        assert_eq!(after[at], expected);
    }
    let store = ConfigStore::load_from(path);
    let doc = store.adapter_document().unwrap();
    assert_eq!(
        doc.evaluate(&format!("{ORIGIN}/alpha-docs/456"), None)
            .unwrap()
            .artifact_id,
        "work.doc:tools.example.com/alpha/456"
    );
    assert_eq!(
        doc.evaluate(&format!("{ORIGIN}/beta-docs/456"), None)
            .unwrap()
            .artifact_id,
        "work.doc:tools.example.com/beta/456"
    );
}

#[test]
fn capture_review_identical_identity_siblings_use_exact_retained_original_rules() {
    let first = adapter(
        ORIGIN,
        "work.doc:{host}/{id}",
        &["/alpha/{id:int}"],
        "{title} · Alpha",
    );
    let second = adapter(
        ORIGIN,
        "work.doc:{host}/{id}",
        &["/beta/{id:int}"],
        "{title} · Beta",
    );
    let (_temp, path, context) = setup(
        &[first.clone(), second.clone()],
        &format!("{ORIGIN}/alpha/123"),
    );
    let first_proposal = proposal(&first, "/alpha-docs/{id:int}");
    let second_proposal = proposal(&second, "/beta-docs/{id:int}");
    apply(
        &path,
        &context,
        &answer(
            vec![first_proposal.clone(), second_proposal.clone()],
            &["/alpha-docs/{num}", "/beta-docs/{num}"],
        ),
    )
    .unwrap();

    let after = tables(&path);
    assert_eq!(after.len(), 2);
    for (at, original, proposed) in [(0, first, first_proposal), (1, second, second_proposal)] {
        let mut expected = original;
        expected["match"] = proposed["match"].clone();
        assert_eq!(after[at], expected);
    }
}

#[test]
fn capture_review_ambiguous_existing_identity_refuses_without_changing_config() {
    let first = adapter(
        ORIGIN,
        "work.doc:{host}/{id}",
        &["/alpha/{id:int}"],
        "{title} · Alpha",
    );
    let second = adapter(
        ORIGIN,
        "work.doc:{host}/{id}",
        &["/beta/{id:int}"],
        "{title} · Beta",
    );
    for paths in [
        vec!["/documents/{id:int}"],
        vec!["/alpha/{id:int}", "/beta/{id:int}", "/documents/{id:int}"],
    ] {
        let (_temp, path, context) = setup(
            &[first.clone(), second.clone()],
            &format!("{ORIGIN}/alpha/123"),
        );
        let before = std::fs::read(&path).unwrap();
        let ambiguous = tier0(&adapter(ORIGIN, "work.doc:{host}/{id}", &paths, "{title}"));
        assert!(
            apply(
                &path,
                &context,
                &answer(vec![ambiguous], &["/documents/{num}"])
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(ConfigStore::load_from(path).revision(), context.revision);
    }
}

#[test]
fn capture_review_new_kind_cannot_borrow_a_different_id_scheme() {
    let initial = adapter(
        ORIGIN,
        "work.doc:{host}/{id}",
        &["/docs/{id:int}"],
        "{title}",
    );
    let (_temp, path, context) = setup(&[initial], &format!("{ORIGIN}/docs/123"));
    let before = std::fs::read(&path).unwrap();
    let result = answer(
        vec![json!({
            "type": "work.report", "origin": ORIGIN,
            "match": [{"path": "/reports/{id:int}"}],
            "id": "borrowed:{host}/{id}"
        })],
        &["/reports/{num}"],
    );
    assert!(apply(&path, &context, &result).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(ConfigStore::load_from(path).revision(), context.revision);
}
