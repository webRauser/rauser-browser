//! Durable Capture Site reviews. The agent observes a site; only this host
//! code publishes additions, through the ordinary revision/history guards.

use std::collections::BTreeSet;
use std::path::Path;

use adapter_templates::{
    Document, Provenance, RuleVerdict, ScopeState, check_draft_rules, scope_state,
};
use brauser_protocol::{CaptureReviewContext, ShapeCount};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::capture_site::{catalog, shape_input};
use crate::config::ConfigStore;
use crate::site_draft_answer::{MAX_SITE_DRAFT_ANSWER_BYTES, parse_site_draft_answer};

const STALE: &str =
    "Settings changed during site capture. Initial rules were kept; start a new capture review.";
const UNSAFE: &str = "The proposed capture rules failed validation. Initial rules were kept.";
const BLOCKED: &str = "The headless site review could not be completed. Initial rules were kept; see the task report.";
const UNAVAILABLE: &str =
    "Capture settings or the selected home folder are unavailable. Initial rules were kept.";
const TIER0: &[&str] = &["type", "origin", "match", "id", "modes", "refs"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    status: ReviewStatus,
    report: String,
    visited: Vec<ShapeCount>,
    links: Vec<ShapeCount>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ReviewStatus {
    Validated,
    Blocked,
}

/// The seed is supplied only by the user's Capture Site action. The host
/// checks it again before saving, and keeps it out of command lines.
pub(crate) fn valid_seed(origin: &str, raw: &str) -> bool {
    if raw.len() > 8_192 || raw.chars().any(char::is_control) {
        return false;
    }
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.origin().ascii_serialization() == origin
        && url.username().is_empty()
        && url.password().is_none()
        && url.query_pairs().all(|(key, _)| {
            let key = key.to_ascii_lowercase();
            let policy = catalog();
            !policy.secret_query_keys.contains(&key)
                && !policy
                    .secret_query_key_parts
                    .iter()
                    .any(|word| key.contains(word))
                && !policy
                    .secret_query_key_suffixes
                    .iter()
                    .any(|word| key.ends_with(word))
        })
}

/// Parse a bounded result, rejecting duplicate keys before serde can erase
/// them. Reports remain plain text. A blocked browser may return no rules.
pub(crate) fn accept(final_text: &str, origin: &str) -> Result<Value, String> {
    if final_text.len() > MAX_SITE_DRAFT_ANSWER_BYTES {
        return Err("the capture review answer is too large".into());
    }
    let text = crate::answer::strip_fence(final_text.trim());
    serde_json::from_str::<adapter_templates::Value>(text)
        .map_err(|_| "the capture review is invalid JSON or repeats a key")?;
    let mut result: Value = serde_json::from_str(text).map_err(|_| "invalid capture review")?;
    let object = result
        .as_object_mut()
        .ok_or("the capture review must be an object")?;
    if object.len() != 2 || !object.contains_key("adapters") || !object.contains_key("review") {
        return Err("the capture review needs only adapters and review".into());
    }
    let review: Review = serde_json::from_value(object["review"].clone())
        .map_err(|_| "review needs status, report, visited and links")?;
    if review.report.trim().is_empty() || review.report.len() > 16 * 1024 {
        return Err("the capture review report is empty or too large".into());
    }
    if shape_input(&review.visited, &review.links).is_none()
        || (review.status == ReviewStatus::Validated && review.visited.is_empty())
    {
        return Err(
            "a validated capture review needs observed page shapes within their bounds".into(),
        );
    }
    let tables = object["adapters"]
        .as_array()
        .ok_or("adapters must be an array")?;
    if !tables.is_empty() {
        parse_site_draft_answer(&json!({"adapters": tables}).to_string(), origin)?;
    }
    let clean: String = review
        .report
        .chars()
        .map(|c| {
            if (c.is_control() && c != '\n' && c != '\t') || crate::presentation::is_format(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    if clean.trim().is_empty() {
        return Err("the capture review report is empty".into());
    }
    object["review"]["report"] = json!(clean.trim());
    Ok(result)
}

fn document(tables: &[Value]) -> Result<Document, String> {
    let value =
        serde_json::from_value(json!({"format": 1, "artifacts": tables})).map_err(|_| UNSAFE)?;
    Document::from_value(&value).map_err(|_| UNSAFE.to_string())
}

pub(crate) fn tier0(table: &Value) -> Value {
    Value::Object(
        table
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, _)| TIER0.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    )
}

/// Compute a conservative addition. Existing kinds, IDs, recognition rules
/// and overlays survive; an agent cannot drop a definition by omitting it.
fn proposed_tables(current: &[Value], origin: &str, result: &Value) -> Result<Vec<Value>, String> {
    let review: Review = serde_json::from_value(result["review"].clone()).map_err(|_| UNSAFE)?;
    if review.status == ReviewStatus::Blocked {
        return Err(BLOCKED.into());
    }
    let input = shape_input(&review.visited, &review.links).ok_or(UNSAFE)?;
    let proposed = result["adapters"].as_array().ok_or(UNSAFE)?;
    let mut output = current.to_vec();
    let mut seen = BTreeSet::new();
    for table in proposed {
        let fields = table.as_object().ok_or(UNSAFE)?;
        if fields.keys().any(|key| !TIER0.contains(&key.as_str())) || table["origin"] != origin {
            return Err(UNSAFE.into());
        }
        let kind = table["type"].as_str().ok_or(UNSAFE)?;
        if !seen.insert(kind.to_string()) {
            return Err(UNSAFE.into());
        }
        let old = current.iter().find(|old| old["type"] == kind);
        if old.is_some_and(|old| old["origin"] != origin) {
            return Err(UNSAFE.into());
        }
        // Stable IDs, mode mappings and reference extraction are never an
        // automatic agent decision, even before an artifact was recorded.
        if let Some(old) = old {
            for key in ["type", "origin", "id", "modes", "refs"] {
                if old[key] != table[key] {
                    return Err(UNSAFE.into());
                }
            }
        } else if catalog()
            .starter_types
            .iter()
            .any(|reserved| reserved == kind)
        {
            return Err(UNSAFE.into());
        }
        let rules = table["match"].as_array().ok_or(UNSAFE)?;
        let additions: Vec<Value> = rules
            .iter()
            .filter(|rule| {
                !old.and_then(|old| old["match"].as_array())
                    .is_some_and(|rules| rules.contains(rule))
            })
            .cloned()
            .collect();
        if additions.is_empty() {
            continue;
        }
        let others: Vec<Value> = output
            .iter()
            .filter(|old| old["type"] != kind)
            .cloned()
            .collect();
        let existing = document(&others)?;
        let mut candidate = table.clone();
        candidate["match"] = json!(additions);
        let candidate_value = serde_json::from_value(candidate.clone()).map_err(|_| UNSAFE)?;
        let report = check_draft_rules(
            &existing,
            &candidate_value,
            &vec![Provenance::Drafted; additions.len()],
            catalog(),
            &[],
        )
        .map_err(|_| UNSAFE)?;
        if report
            .rules
            .iter()
            .any(|rule| !matches!(rule, RuleVerdict::Kept))
        {
            return Err(UNSAFE.into());
        }
        // Each new rule must recognize an actually observed page; links
        // alone and invented routes cannot silently widen capture.
        // Reuse the complete ordinary agent-draft checks, including blocked
        // observed routes hidden by captures and links not actually visited.
        // That drafter may rename a reserved type; only its verdicts are
        // used here. Publication retains the exact original type and ID.
        let judged = adapter_templates::structural::check_agent_draft(
            origin,
            &existing,
            &[],
            &input,
            catalog(),
            &[],
            std::slice::from_ref(&candidate_value),
        );
        if judged.rejected.is_some()
            || !judged.dropped_rules.is_empty()
            || judged.adapters.len() != 1
            || judged.adapters[0].rules.len() != additions.len()
            || judged.adapters[0]
                .rules
                .iter()
                .any(|rule| rule.unseen || rule.link_only)
        {
            return Err(UNSAFE.into());
        }
        let saved = if let Some(old) = old {
            let mut saved = old.clone();
            let list = saved["match"].as_array_mut().ok_or(UNSAFE)?;
            list.extend(additions);
            saved
        } else {
            let full = document(current)?;
            match scope_state(&full, Some(origin), catalog()) {
                ScopeState::NotShared => {}
                ScopeState::Copied(_) => {
                    candidate["scope"] = current
                        .iter()
                        .find(|old| old["origin"] == origin && old["scope"].is_object())
                        .ok_or(UNSAFE)?["scope"]
                        .clone();
                }
                ScopeState::Pending { .. } | ScopeState::UnscopedOnly => {
                    let site: Vec<_> = current
                        .iter()
                        .filter(|old| old["origin"] == origin)
                        .collect();
                    if report.scope_anchored
                        || site.is_empty()
                        || site.iter().any(|old| old["unscoped"] != "acknowledged")
                    {
                        return Err(UNSAFE.into());
                    }
                    candidate["unscoped"] = json!("acknowledged");
                }
            }
            candidate
        };
        if let Some(at) = output.iter().position(|old| old["type"] == kind) {
            output[at] = saved;
        } else {
            output.push(saved);
        }
        document(&output)?;
    }
    Ok(output)
}

/// Publish under the ordinary config CAS/history checks. A stale review
/// cannot overwrite a user's settings edit, site removal, pause or folder.
pub(crate) fn save(
    path: &Path,
    context: &CaptureReviewContext,
    result: &Value,
) -> Result<(), String> {
    let origin = url::Url::parse(&context.url)
        .map_err(|_| UNSAFE)?
        .origin()
        .ascii_serialization();
    if !valid_seed(&origin, &context.url) {
        return Err(UNSAFE.into());
    }
    let result = accept(&result.to_string(), &origin)?;
    let mut store = ConfigStore::load_from(path.to_path_buf());
    let next = {
        let _lock = store.lock_current().map_err(|_| UNAVAILABLE)?;
        store.refresh().map_err(|_| UNAVAILABLE)?;
        if store.revision() != context.revision {
            return Err(STALE.into());
        }
        if store.config_issue().is_some() || store.adapter_issue().is_some() || !store.configured()
        {
            return Err(UNAVAILABLE.into());
        }
        let current = store.snapshot();
        if !current
            .adapters
            .artifacts
            .iter()
            .any(|table| table.get("origin").and_then(Value::as_str) == Some(&origin))
        {
            return Err(STALE.into());
        }
        let tables = &current.adapters.artifacts;
        let proposed = proposed_tables(tables, &origin, &result)?;
        let mut next = current.clone();
        next.adapters = serde_json::from_value(json!({"format": 1, "artifacts": proposed}))
            .map_err(|_| UNSAFE)?;
        store
            .check_capture_site(&next.adapters)
            .map_err(|_| UNSAFE)?;
        if next == *current {
            return Ok(());
        }
        next
    };
    // update re-locks and checks both the exact revision and recorded
    // contracts again, closing races with a concurrent host or editor.
    store
        .update_with_grants(next, &context.revision, None, None, None)
        .map_err(|_| UNSAFE)?
        .ok_or_else(|| STALE.to_string())
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::fixtures;

    const ORIGIN: &str = "https://tools.example.com";
    const TABLE: &str = "[[artifacts]]\ntype = \"tools.doc\"\norigin = \"https://tools.example.com\"\nmatch = [{ path = \"/docs/{id:int}\" }]\nid = \"tools.doc:{host}/{id}\"\ntitle = \"{title} · Example\"\n";

    fn adapter(path: &str) -> Value {
        json!({"type":"tools.doc","origin":ORIGIN,"match":[{"path":path}],"id":"tools.doc:{host}/{id}"})
    }

    fn result(tables: Vec<Value>, shapes: &[&str]) -> Value {
        json!({"adapters":tables,"review":{"status":"validated","report":"Observed documents in a headless browser and checked the rules.",
            "visited":shapes.iter().map(|shape| json!({"shape":shape,"count":1})).collect::<Vec<_>>(),"links":[]}})
    }

    fn setup() -> (tempfile::TempDir, std::path::PathBuf, CaptureReviewContext) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home");
        std::fs::create_dir(&root).unwrap();
        let path = temp.path().join("config.toml");
        fixtures::write(&path, &root, "", "", TABLE);
        let config = ConfigStore::load_from(path.clone());
        let context = CaptureReviewContext {
            start_request_id: "review-test".into(),
            url: format!("{ORIGIN}/docs/123"),
            revision: config.revision().into(),
            visited: vec![],
            links: vec![],
        };
        (temp, path, context)
    }

    #[test]
    fn capture_review_parses_observations_and_refuses_duplicate_or_unobserved_answers() {
        let good = result(vec![adapter("/docs/{id:int}")], &["/docs/{num}"]);
        assert_eq!(accept(&good.to_string(), ORIGIN).unwrap(), good);
        let empty = result(vec![], &[]);
        assert!(accept(&empty.to_string(), ORIGIN).is_err());
        assert!(accept("{\"adapters\":[],\"review\":{},\"review\":{}}", ORIGIN).is_err());
        let mut bad = good.clone();
        bad["review"]["visited"][0]["shape"] = json!("https://tools.example.com/docs/123");
        assert!(accept(&bad.to_string(), ORIGIN).is_err());
        let mut blocked = empty;
        blocked["review"]["status"] = json!("blocked");
        assert!(accept(&blocked.to_string(), ORIGIN).is_ok());
    }

    #[test]
    fn capture_review_seed_refuses_credentials_cross_origin_and_capability_tokens() {
        assert!(valid_seed(ORIGIN, &format!("{ORIGIN}/docs/123?mode=view")));
        for url in [
            "https://other.example/docs/123",
            "https://user:pass@tools.example.com/docs/123",
            "https://tools.example.com/docs/123?access_token=secret",
            "file:///tmp/page",
        ] {
            assert!(!valid_seed(ORIGIN, url));
        }
    }

    #[test]
    fn capture_review_adds_observed_routes_and_preserves_overlays_and_pause() {
        let (_temp, path, context) = setup();
        let before = ConfigStore::load_from(path.clone()).snapshot().clone();
        let answer = result(vec![adapter("/documents/{id:int}")], &["/documents/{num}"]);
        save(&path, &context, &answer).unwrap();
        let after = ConfigStore::load_from(path).snapshot().clone();
        assert_eq!(after.capture_enabled, before.capture_enabled);
        assert_eq!(after.storage, before.storage);
        assert_eq!(
            after.adapters.artifacts[0]["title"],
            before.adapters.artifacts[0]["title"]
        );
        assert_eq!(
            after.adapters.artifacts[0]["id"],
            before.adapters.artifacts[0]["id"]
        );
        assert_eq!(
            after.adapters.artifacts[0]["match"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn capture_review_stale_blocked_unsafe_and_unseen_answers_never_change_config() {
        for case in ["stale", "blocked", "unsafe", "unseen", "identity", "scope"] {
            let (_temp, path, mut context) = setup();
            let before = std::fs::read(&path).unwrap();
            let mut answer = result(vec![adapter("/documents/{id:int}")], &["/documents/{num}"]);
            match case {
                "stale" => context.revision = "sha256:stale".into(),
                "blocked" => answer["review"]["status"] = json!("blocked"),
                "unsafe" => answer["adapters"][0]["match"] = json!([{"path":"/{id:token}"}]),
                "unseen" => {
                    answer["review"]["visited"] = json!([{"shape":"/docs/{num}","count":1}])
                }
                "identity" => {
                    answer["adapters"][0]["id"] = json!("tools.doc:{host}/different/{id}")
                }
                "scope" => answer["adapters"][0]["unscoped"] = json!("acknowledged"),
                _ => unreachable!(),
            }
            assert!(save(&path, &context, &answer).is_err(), "{case}");
            assert_eq!(std::fs::read(path).unwrap(), before, "{case}");
        }
    }

    #[test]
    fn capture_review_can_validate_unchanged_rules_without_removing_unmentioned_kinds() {
        let (_temp, path, context) = setup();
        let before = ConfigStore::load_from(path.clone()).snapshot().clone();
        save(&path, &context, &result(vec![], &["/docs/{num}"])).unwrap();
        assert_eq!(ConfigStore::load_from(path).snapshot(), &before);
    }

    #[test]
    fn capture_review_reuses_blocked_observed_route_and_unvisited_link_guards() {
        for blocked in [true, false] {
            let (_temp, path, context) = setup();
            let before = std::fs::read(&path).unwrap();
            let mut answer = result(
                vec![adapter("/documents/{id:int}/{*}")],
                &[if blocked {
                    "/documents/{num}/login"
                } else {
                    "/documents/{num}/view"
                }],
            );
            if !blocked {
                answer["review"]["links"] = json!([{"shape":"/documents/{num}/export","count":1}]);
            }
            assert!(save(&path, &context, &answer).is_err(), "blocked={blocked}");
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn capture_review_new_kind_copies_exact_workspace_scope() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home");
        std::fs::create_dir(&root).unwrap();
        let path = temp.path().join("config.toml");
        fixtures::write(
            &path,
            &root,
            "",
            "capture_enabled = false",
            r#"[[artifacts]]
type = "work.issue"
origin = "https://linear.app"
match = [{ path = "/{workspace:name|lower}/issues/{id:int}" }]
id = "work.issue:{host}/{workspace}/{id}"
scope = { workspace = ["alpha", "beta"] }
title = "{title} · Example"
"#,
        );
        let before = ConfigStore::load_from(path.clone());
        let original = before.snapshot().adapters.artifacts[0].clone();
        let context = CaptureReviewContext {
            start_request_id: "scope-review-test".into(),
            url: "https://linear.app/alpha/issues/123".into(),
            revision: before.revision().into(),
            visited: vec![],
            links: vec![],
        };
        let answer = result(
            vec![json!({
                "type": "work.document",
                "origin": "https://linear.app",
                "match": [{"path": "/{workspace:name|lower}/docs/{id:int}"}],
                "id": "work.document:{host}/{workspace}/{id}"
            })],
            &["/{slug}/docs/{num}"],
        );

        save(&path, &context, &answer).unwrap();

        let after = ConfigStore::load_from(path);
        assert_eq!(after.snapshot().adapters.artifacts[0], original);
        assert_eq!(
            after.snapshot().adapters.artifacts[1]["scope"],
            json!({"workspace": ["alpha", "beta"]})
        );
        assert!(!after.snapshot().capture_enabled);
        let rules = after.adapter_document().unwrap();
        for workspace in ["alpha", "beta"] {
            assert!(
                rules
                    .evaluate(&format!("https://linear.app/{workspace}/docs/123"), None)
                    .is_ok()
            );
        }
        assert!(
            rules
                .evaluate("https://linear.app/gamma/docs/123", None)
                .is_err()
        );
    }

    #[test]
    fn capture_review_cannot_claim_a_retired_routes_identity() {
        let (_temp, path, mut context) = setup();
        let mut store = ConfigStore::load_from(path.clone());
        let mut with_legacy = store.snapshot().clone();
        with_legacy.adapters.artifacts.push(json!({
            "type": "tools.legacy",
            "origin": ORIGIN,
            "match": [{"path": "/retired/{id:int}"}],
            "id": "tools.legacy:{host}/{id}"
        }));
        let revision = store.revision().to_owned();
        let revision = store.update(with_legacy, &revision).unwrap().unwrap();
        let mut retired = store.snapshot().clone();
        retired.adapters.artifacts.remove(1);
        context.revision = store.update(retired, &revision).unwrap().unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(
            std::str::from_utf8(&before)
                .unwrap()
                .contains("[[adapter_id_history]]")
        );
        let answer = result(vec![adapter("/retired/{id:int}")], &["/retired/{num}"]);

        assert!(save(&path, &context, &answer).is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[test]
    fn capture_review_refuses_a_replaced_selected_home() {
        let (temp, path, context) = setup();
        let root = temp.path().join("home");
        let retained = temp.path().join("original-home");
        std::fs::write(root.join("keep.txt"), "original content").unwrap();
        std::fs::rename(&root, &retained).unwrap();
        std::fs::create_dir(&root).unwrap();
        let before = std::fs::read(&path).unwrap();
        let answer = result(vec![adapter("/documents/{id:int}")], &["/documents/{num}"]);

        assert!(save(&path, &context, &answer).is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
        assert_eq!(
            std::fs::read_to_string(retained.join("keep.txt")).unwrap(),
            "original content"
        );
    }

    #[test]
    fn capture_review_unchanged_result_preserves_exact_config_bytes_and_revision() {
        let (_temp, path, mut context) = setup();
        let mut original = std::fs::read_to_string(&path).unwrap();
        original.push_str("\n# Preserve this owner's formatting on a validated no-op.\n");
        std::fs::write(&path, original.as_bytes()).unwrap();
        context.revision = ConfigStore::load_from(path.clone()).revision().to_owned();
        let answer = result(vec![], &["/docs/{num}"]);

        for _ in 0..2 {
            save(&path, &context, &answer).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), original.as_bytes());
            assert_eq!(
                ConfigStore::load_from(path.clone()).revision(),
                context.revision
            );
        }
    }
}
