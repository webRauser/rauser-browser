use std::{fs, path::Path};

use brauser_protocol::{
    ImportanceLevel, RecordKey, RecordKeyKind, StashItem, StashSummary, StashSummaryIssue,
    StorageConfig,
};
use serde_json::{Value, json};

use super::{SavedPage, Unavailable, complete, list, save};
use crate::{
    layout,
    markdown::yaml_string,
    vault::{OwnedWrite, Vault, url_record_key},
};

const URL: &str = "https://example.com/articles/42";

fn storage(root: &Path) -> StorageConfig {
    StorageConfig {
        root: root.to_string_lossy().into_owned(),
        profile: "neutral".into(),
        log_dir: layout::LOGS_DIR.into(),
        pages_dir: layout::NOTES_DIR.into(),
        later_dir: layout::LATER_DIR.into(),
        artifacts_dir: layout::ARTIFACTS_DIR.into(),
        summaries_dir: Some(layout::SUMMARIES_DIR.into()),
        knowledge_base_dir: None,
    }
}

fn fixture() -> (tempfile::TempDir, Vault) {
    let root = tempfile::tempdir().unwrap();
    let vault = Vault::open(&storage(root.path())).unwrap();
    (root, vault)
}

fn only_item(vault: &Vault, state: &str) -> StashItem {
    let (mut items, next) = list(vault, state, "", None, false).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(next, None);
    items.pop().unwrap()
}

fn saved(already_saved: bool, needs_summary: bool) -> SavedPage {
    SavedPage {
        already_saved,
        needs_summary,
        summary_issue: None,
    }
}

fn summary_file(key: &RecordKey, fields: &str) -> String {
    format!(
        "---\nbrauser:\n  kind: summary\n  canonical_url: {}\n  url_id: {}\n\
         overview: \"Fixture overview\"\ndocument_type: \"Article\"\ncategory: \"Research\"\n\
         importance: medium\n{fields}---\n\nSummary body.\nread_scope: whole\n",
        yaml_string(URL),
        yaml_string(&key.value)
    )
}

fn write_summary(vault: &Vault, key: &RecordKey, fields: &str) {
    assert!(matches!(
        vault
            .write_summary(key, URL, &summary_file(key, fields))
            .unwrap(),
        OwnedWrite::Written(_)
    ));
}

#[test]
fn repeating_and_saving_an_alias_preserve_the_first_receipt() {
    let (root, vault) = fixture();
    let key = RecordKey {
        kind: RecordKeyKind::Artifact,
        value: "example:example.com/42".into(),
    };
    assert_eq!(
        save(&vault, key.clone(), URL.into(), "First title").unwrap(),
        saved(false, true)
    );
    let first = only_item(&vault, "open");
    let later = root.path().join(layout::LATER_DIR);
    let entry = later.join(format!("{}.md", first.id));
    let receipt = fs::read(&entry).unwrap();

    assert_eq!(
        save(&vault, key.clone(), URL.into(), "First title").unwrap(),
        saved(true, true)
    );
    assert_eq!(
        save(
            &vault,
            key,
            "https://example.com/alternate/42".into(),
            "Alias title"
        )
        .unwrap(),
        saved(true, true)
    );
    assert_eq!(first.title, "First title");
    assert_eq!(first.url, URL);
    assert_eq!(only_item(&vault, "open"), first);
    assert_eq!(fs::read(entry).unwrap(), receipt);
    assert_eq!(fs::read_dir(later).unwrap().count(), 1);
}

#[test]
fn an_owned_summary_appears_after_an_entry_was_saved() {
    let (_root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    assert_eq!(
        save(&vault, key.clone(), URL.into(), "Article").unwrap(),
        saved(false, true)
    );
    let pending = only_item(&vault, "open");
    assert_eq!(pending.summary, None);

    write_summary(&vault, &key, "");
    let mut summarized = only_item(&vault, "open");
    let summary = summarized.summary.take().unwrap();
    assert_eq!(summarized, pending);
    assert!(summary.path.starts_with("summaries/"));
    assert_eq!(summary.overview.as_deref(), Some("Fixture overview"));
    assert_eq!(summary.document_type.as_deref(), Some("Article"));
    assert_eq!(summary.category.as_deref(), Some("Research"));
    assert_eq!(summary.importance, Some(ImportanceLevel::Medium));
    assert_eq!(
        save(&vault, key, URL.into(), "Article").unwrap(),
        saved(true, false)
    );
}

#[test]
fn stash_projects_only_recognized_read_scope_from_owned_frontmatter() {
    let (_root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    save(&vault, key.clone(), URL.into(), "Article").unwrap();

    for (fields, expected) in [
        ("read_scope: whole\n", Some("whole")),
        ("read_scope: partial\n", Some("partial")),
        ("read_scope: page_only\n", Some("page_only")),
        ("", None),
        ("read_scope: most\n", None),
        ("read_scope: \"whole\"\n", None),
        ("read_scope: whole\nread_scope: page_only\n", None),
    ] {
        write_summary(&vault, &key, fields);
        let summary = only_item(&vault, "open").summary.unwrap();
        let wire = serde_json::to_value(&summary).unwrap();
        assert_eq!(
            wire.get("read_scope").cloned(),
            expected.map(Value::from),
            "summary frontmatter fields: {fields:?}"
        );
        assert_eq!(
            serde_json::from_value::<StashSummary>(wire).unwrap(),
            summary
        );
    }
}

#[test]
fn stash_summary_rejects_unknown_wire_scope() {
    let mut wire = json!({
        "path": "summaries/article-aaaaaaaa.summary.md",
        "overview": null,
        "document_type": null,
        "category": null,
        "importance": null,
        "summarized_at": null,
    });
    for invalid in [json!("most"), json!("Whole"), json!(true)] {
        wire["read_scope"] = invalid;
        assert!(serde_json::from_value::<StashSummary>(wire.clone()).is_err());
    }
}

#[test]
fn completion_rejects_stale_versions_and_preserves_conflicting_files() {
    let (root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    save(&vault, key.clone(), URL.into(), "Article").unwrap();
    let item = only_item(&vault, "open");
    let later = root.path().join(layout::LATER_DIR);
    let entry = later.join(format!("{}.md", item.id));
    let marker = later.join(format!("{}.done.md", item.id));

    let stale = complete(&vault, &item.id, &"0".repeat(64)).unwrap_err();
    assert!(matches!(stale.downcast_ref(), Some(Unavailable::Changed)));
    assert!(!marker.exists());

    fs::write(&marker, "Unrelated completion file").unwrap();
    let blocked = complete(&vault, &item.id, &item.version).unwrap_err();
    assert!(matches!(
        blocked.downcast_ref(),
        Some(Unavailable::Occupied)
    ));
    assert_eq!(
        fs::read_to_string(&marker).unwrap(),
        "Unrelated completion file"
    );
    assert_eq!(only_item(&vault, "open"), item);

    let edited = fs::read_to_string(&entry).unwrap() + "An external edit.\n";
    fs::write(&entry, &edited).unwrap();
    let blocked = save(&vault, key, URL.into(), "New title").unwrap_err();
    assert!(matches!(
        blocked.downcast_ref(),
        Some(Unavailable::Occupied)
    ));
    let changed = complete(&vault, &item.id, &item.version).unwrap_err();
    assert!(matches!(changed.downcast_ref(), Some(Unavailable::Changed)));
    assert!(list(&vault, "all", "", None, false).unwrap().0.is_empty());
    assert_eq!(fs::read_to_string(entry).unwrap(), edited);
    assert_eq!(
        fs::read_to_string(marker).unwrap(),
        "Unrelated completion file"
    );
}

#[test]
fn an_unowned_summary_is_neither_reused_nor_overwritten() {
    let (root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    save(&vault, key.clone(), URL.into(), "Article").unwrap();
    let summary = root
        .path()
        .join(vault.summary_relative_path(&key, URL).unwrap());
    fs::create_dir_all(summary.parent().unwrap()).unwrap();
    let other = url_record_key("https://example.com/other").unwrap();
    let unrelated = summary_file(&other, "read_scope: whole\n");
    fs::write(&summary, &unrelated).unwrap();

    assert_eq!(
        save(&vault, key, URL.into(), "New title").unwrap(),
        SavedPage {
            summary_issue: Some(StashSummaryIssue::Conflict),
            ..saved(true, false)
        }
    );
    let item = only_item(&vault, "open");
    assert_eq!(item.summary, None);
    assert_eq!(item.summary_issue, Some(StashSummaryIssue::Conflict));
    assert_eq!(fs::read_to_string(summary).unwrap(), unrelated);
}

#[cfg(unix)]
#[test]
fn a_temporarily_unreadable_summary_leaves_the_link_usable() {
    use std::{io::ErrorKind, os::unix::fs::PermissionsExt};

    if rustix::process::geteuid().is_root() {
        eprintln!("POSIX file permissions do not block a root process");
        return;
    }
    let (root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    write_summary(&vault, &key, "read_scope: whole\n");
    let path = root
        .path()
        .join(vault.summary_relative_path(&key, URL).unwrap());
    let original = fs::read(&path).unwrap();
    let permissions = fs::metadata(&path).unwrap().permissions();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    let lookup = vault.find_stash_summary(&key, URL);
    let outcome = save(&vault, key.clone(), URL.into(), "Article");
    let listing = list(&vault, "open", "", None, false);
    fs::set_permissions(&path, permissions).unwrap();

    assert_eq!(
        lookup
            .unwrap_err()
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .kind(),
        ErrorKind::PermissionDenied
    );
    assert_eq!(
        outcome.unwrap(),
        SavedPage {
            summary_issue: Some(StashSummaryIssue::Unavailable),
            ..saved(false, false)
        }
    );
    let (items, next) = listing.unwrap();
    let [blocked] = items.as_slice() else {
        panic!("expected one saved Stash link");
    };
    assert_eq!(next, None);
    assert_eq!(blocked.url, URL);
    assert_eq!(blocked.summary, None);
    assert_eq!(blocked.summary_issue, Some(StashSummaryIssue::Unavailable));

    let mut recovered = only_item(&vault, "open");
    assert!(recovered.summary.take().is_some());
    assert_eq!(recovered.summary_issue, None);
    recovered.summary_issue = blocked.summary_issue;
    assert_eq!(&recovered, blocked);
    assert_eq!(
        save(&vault, key, URL.into(), "Retry").unwrap(),
        saved(true, false)
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn completion_survives_reopen_and_keeps_the_original_entry_and_summary() {
    let (root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    write_summary(&vault, &key, "");
    assert_eq!(
        save(&vault, key.clone(), URL.into(), "Article").unwrap(),
        saved(false, false)
    );
    let mut item = only_item(&vault, "open");
    let later = root.path().join(layout::LATER_DIR);
    let entry = later.join(format!("{}.md", item.id));
    let marker = later.join(format!("{}.done.md", item.id));
    let summary = root
        .path()
        .join(vault.summary_relative_path(&key, URL).unwrap());
    let original_entry = fs::read(&entry).unwrap();
    let original_summary = fs::read(&summary).unwrap();

    complete(&vault, &item.id, &item.version).unwrap();
    let completion = fs::read(&marker).unwrap();
    drop(vault);

    let reopened = Vault::open(&storage(root.path())).unwrap();
    assert!(
        list(&reopened, "open", "", None, false)
            .unwrap()
            .0
            .is_empty()
    );
    item.done = true;
    assert_eq!(only_item(&reopened, "done"), item);
    complete(&reopened, &item.id, &item.version).unwrap();
    assert_eq!(
        save(&reopened, key, URL.into(), "Article").unwrap(),
        saved(true, false)
    );
    assert_eq!(fs::read(entry).unwrap(), original_entry);
    assert_eq!(fs::read(summary).unwrap(), original_summary);
    assert_eq!(fs::read(marker).unwrap(), completion);
    assert_eq!(fs::read_dir(later).unwrap().count(), 2);
}

#[cfg(unix)]
#[test]
fn symlinked_receipts_and_completion_markers_are_ignored_and_preserved() {
    use std::os::unix::fs::symlink;

    let (root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    save(&vault, key.clone(), URL.into(), "Article").unwrap();
    let item = only_item(&vault, "open");
    let later = root.path().join(layout::LATER_DIR);
    let entry = later.join(format!("{}.md", item.id));
    let marker = later.join(format!("{}.done.md", item.id));
    complete(&vault, &item.id, &item.version).unwrap();

    let real_marker = later.join("original.marker");
    let marker_bytes = fs::read(&marker).unwrap();
    fs::rename(&marker, &real_marker).unwrap();
    symlink("original.marker", &marker).unwrap();
    assert_eq!(only_item(&vault, "open"), item);
    let blocked = complete(&vault, &item.id, &item.version).unwrap_err();
    assert!(matches!(
        blocked.downcast_ref(),
        Some(Unavailable::Occupied)
    ));
    assert!(
        fs::symlink_metadata(marker)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read(real_marker).unwrap(), marker_bytes);

    let real_entry = later.join("original.entry");
    let entry_bytes = fs::read(&entry).unwrap();
    fs::rename(&entry, &real_entry).unwrap();
    symlink("original.entry", &entry).unwrap();
    let blocked = save(&vault, key, URL.into(), "Article").unwrap_err();
    assert!(matches!(
        blocked.downcast_ref(),
        Some(Unavailable::Occupied)
    ));
    assert!(list(&vault, "all", "", None, false).unwrap().0.is_empty());
    assert!(
        fs::symlink_metadata(entry)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read(real_entry).unwrap(), entry_bytes);
}

#[cfg(unix)]
#[test]
fn a_symlinked_stash_directory_is_refused() {
    use std::os::unix::fs::symlink;

    let (root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    save(&vault, key.clone(), URL.into(), "Article").unwrap();
    let item = only_item(&vault, "open");
    let later = root.path().join(layout::LATER_DIR);
    let target = root.path().join("other");
    fs::rename(&later, &target).unwrap();
    symlink("other", &later).unwrap();

    assert!(save(&vault, key, URL.into(), "Article").is_err());
    assert!(list(&vault, "all", "", None, false).is_err());
    assert!(complete(&vault, &item.id, &item.version).is_err());
    assert!(
        fs::symlink_metadata(later)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_dir(target).unwrap().count(), 1);
}

#[test]
fn maximum_length_url_round_trips_through_an_escaped_receipt() {
    let (_root, vault) = fixture();
    let base = "https://example.com/?value=";
    let url = format!("{base}{}", "~".repeat(8192 - base.len()));
    let key = url_record_key(&url).unwrap();
    assert_eq!(
        save(&vault, key, url.clone(), "Long source").unwrap(),
        saved(false, true)
    );
    let item = only_item(&vault, "open");
    assert_eq!(item.url, url);
    complete(&vault, &item.id, &item.version).unwrap();
    assert!(only_item(&vault, "done").done);
}

#[test]
fn list_orders_fractional_timestamps_as_instants() {
    let (root, vault) = fixture();
    let later = root.path().join(layout::LATER_DIR);
    fs::create_dir(&later).unwrap();
    for (title, saved_at) in [
        ("early", "2026-11-23T16:00:00.1Z"), // timing-ok: Fixed data exercises ordering within the same second, independent of the wall clock.
        ("late", "2026-11-23T16:00:00.11Z"), // timing-ok: Fixed data exercises ordering within the same second, independent of the wall clock.
    ] {
        let url = format!("https://example.com/{title}");
        let entry = super::Entry {
            key: url_record_key(&url).unwrap(),
            url,
            title: title.into(),
            saved_at: saved_at.into(),
        };
        fs::write(later.join(format!("{}.md", entry.id())), entry.render()).unwrap();
    }
    let (items, _) = list(&vault, "open", "", None, false).unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| item.title.as_str())
            .collect::<Vec<_>>(),
        ["late", "early"]
    );
}

#[cfg(unix)]
#[test]
fn stash_neither_reuses_nor_lists_summaries_behind_a_directory_symlink() {
    use std::os::unix::fs::symlink;

    let (root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    save(&vault, key.clone(), URL.into(), "Article").unwrap();
    write_summary(&vault, &key, "read_scope: whole\n");
    let summaries = root.path().join(layout::SUMMARIES_DIR);
    fs::rename(&summaries, root.path().join("other")).unwrap();
    symlink("other", summaries).unwrap();

    let item = only_item(&vault, "open");
    assert_eq!(item.summary, None);
    assert_eq!(item.summary_issue, Some(StashSummaryIssue::Conflict));
    assert_eq!(
        save(&vault, key, URL.into(), "Article").unwrap(),
        SavedPage {
            summary_issue: Some(StashSummaryIssue::Conflict),
            ..saved(true, false)
        }
    );
}
