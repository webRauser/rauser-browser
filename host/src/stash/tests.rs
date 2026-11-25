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
    let super::ListPage {
        mut items, next, ..
    } = list(vault, state, "", None, false, None).unwrap();
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
    assert!(
        list(&vault, "all", "", None, false, None)
            .unwrap()
            .items
            .is_empty()
    );
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
    let listing = list(&vault, "open", "", None, false, None);
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
    let super::ListPage { items, next, .. } = listing.unwrap();
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
        list(&reopened, "open", "", None, false, None)
            .unwrap()
            .items
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
    assert!(
        list(&vault, "all", "", None, false, None)
            .unwrap()
            .items
            .is_empty()
    );
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
    assert!(list(&vault, "all", "", None, false, None).is_err());
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
    let super::ListPage { items, .. } = list(&vault, "open", "", None, false, None).unwrap();
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

#[test]
fn pin_owner_first_use_ignores_empty_stage_and_rechecks_other_config() {
    use super::pins::Pins;

    let (home, vault) = fixture();
    let stage = home
        .path()
        .join("stash-pins-00000000-0000-4000-8000-000000000001");
    fs::create_dir(&stage).unwrap();
    save(&vault, url_record_key(URL).unwrap(), URL.into(), "Article").unwrap();
    let entry = only_item(&vault, "all");
    let first = Pins::load(&vault).unwrap();
    let second = Pins::load(&vault).unwrap();
    let baseline = first.view(&entry.id, &entry.version).unwrap();
    let pinned = first
        .set(
            &vault,
            &entry.id,
            &entry.version,
            &baseline.version,
            true,
            || Ok(()),
        )
        .unwrap();
    assert!(matches!(
        second
            .set(
                &vault,
                &entry.id,
                &entry.version,
                &baseline.version,
                true,
                || Ok(())
            )
            .unwrap_err()
            .downcast_ref::<Unavailable>(),
        Some(Unavailable::Changed)
    ));
    assert_eq!(fs::read_dir(&stage).unwrap().count(), 0);
    let names = fs::read_dir(home.path())
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("stash-pins-")
        })
        .count();
    assert_eq!(names, 2);
    let current = Pins::load(&vault).unwrap();
    assert_eq!(current.view(&entry.id, &entry.version).unwrap(), pinned);
}

#[test]
fn pin_owner_change_refuses_a_previously_opened_home() {
    use super::pins::Pins;

    let (home, vault) = fixture();
    save(&vault, url_record_key(URL).unwrap(), URL.into(), "Article").unwrap();
    let entry = only_item(&vault, "all");
    let before_owner = Pins::load(&vault).unwrap();
    let version = before_owner
        .view(&entry.id, &entry.version)
        .unwrap()
        .version;
    let pinned = Pins::load(&vault)
        .unwrap()
        .set(&vault, &entry.id, &entry.version, &version, true, || Ok(()))
        .unwrap();
    let with_owner = Pins::load(&vault).unwrap();
    let marker = home.path().join("stash-pins.owner");
    let retained = marker.with_extension("retained");
    fs::rename(&marker, &retained).unwrap();

    for (snapshot, expected, desired) in [
        (before_owner, version, true),
        (with_owner, pinned.version, false),
    ] {
        assert!(matches!(
            snapshot
                .set(
                    &vault,
                    &entry.id,
                    &entry.version,
                    &expected,
                    desired,
                    || Ok(())
                )
                .unwrap_err()
                .downcast_ref::<Unavailable>(),
            Some(Unavailable::PinHistory)
        ));
        assert!(!marker.exists());
    }

    fs::rename(&retained, &marker).unwrap();
    let verified = Pins::load(&vault).unwrap();
    assert!(verified.view(&entry.id, &entry.version).unwrap().pinned);
}

#[cfg(unix)]
#[test]
fn pin_owner_absence_refuses_linked_namespace_even_when_target_is_empty() {
    use super::pins::Pins;
    use std::os::unix::fs::symlink;

    let (home, vault) = fixture();
    let target = tempfile::tempdir().unwrap();
    let link = home
        .path()
        .join("stash-pins-00000000-0000-4000-8000-000000000001");
    symlink(target.path(), &link).unwrap();
    let error = Pins::load(&vault)
        .err()
        .expect("linked namespace was accepted");
    assert!(matches!(
        error.downcast_ref::<Unavailable>(),
        Some(Unavailable::PinHistory)
    ));
    assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
    assert_eq!(fs::read_dir(target.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn pin_lock_identity_rejects_a_missing_linked_or_replaced_file() {
    use crate::config::ConfigStore;
    use std::os::unix::fs::symlink;

    let config = tempfile::tempdir().unwrap();
    let store = ConfigStore::for_test(config.path().join("config.toml"));
    let path = config.path().join(".config.lock");
    let original = config.path().join("retained-lock");
    let held = store.lock_current().unwrap();
    assert!(held.still_names_held_file());

    fs::rename(&path, &original).unwrap();
    assert!(!held.still_names_held_file());
    symlink(&original, &path).unwrap();
    assert!(!held.still_names_held_file());
    fs::remove_file(&path).unwrap();
    let replacement = store.lock_for_read().unwrap();
    assert!(replacement.still_names_held_file());
    assert!(!held.still_names_held_file());
}

#[test]
fn reading_change_refuses_an_unowned_transition_without_replacing_it() {
    let (root, vault) = fixture();
    save(
        &vault,
        url_record_key(URL).unwrap(),
        URL.into(),
        "Saved page",
    )
    .unwrap();
    let item = only_item(&vault, "open");
    let (_, done_version) =
        super::set_reading(&vault, &item.id, &item.version, None, true, || Ok(())).unwrap();
    let journal = root
        .path()
        .join(layout::LATER_DIR)
        .join(".brauser-stash-reading")
        .join(&item.id);
    fs::create_dir_all(&journal).unwrap();
    let occupied = journal.join(format!("{done_version}.md"));
    fs::write(&occupied, "User content").unwrap();

    let error = super::set_reading(
        &vault,
        &item.id,
        &item.version,
        Some(&done_version),
        false,
        || Ok(()),
    )
    .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Unavailable>(),
        Some(Unavailable::Occupied)
    ));
    assert_eq!(fs::read_to_string(occupied).unwrap(), "User content");
}

#[test]
fn occupied_reading_transition_leaves_other_pages_listable() {
    let (root, vault) = fixture();
    save(
        &vault,
        url_record_key(URL).unwrap(),
        URL.into(),
        "Stash item",
    )
    .unwrap();
    let item = only_item(&vault, "open");
    let (_, done_version) =
        super::set_reading(&vault, &item.id, &item.version, None, true, || Ok(())).unwrap();
    let journal = root
        .path()
        .join(layout::LATER_DIR)
        .join(".brauser-stash-reading")
        .join(&item.id);
    fs::create_dir_all(&journal).unwrap();
    fs::write(journal.join(format!("{done_version}.md")), "User content").unwrap();

    let other = "https://example.test/another";
    save(
        &vault,
        url_record_key(other).unwrap(),
        other.into(),
        "Another Stash item",
    )
    .unwrap();

    let facets = brauser_protocol::StashSearchQuery {
        source_host: None,
        document_type: None,
        coverage: None,
        revision: None,
    };
    for search in [None, Some(&facets)] {
        let page = super::list_using(
            &vault,
            super::ListOptions {
                state: "all",
                query: if search.is_some() { "stash" } else { "" },
                after: None,
                include_pin: false,
                expected_pin_order: None,
                search,
                include_reading: true,
            },
        )
        .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].url, other);
        assert!(page.items[0].reading_version.is_some());
    }
}

#[test]
fn a_gap_in_reading_history_cannot_revive_a_stale_undo() {
    let (root, vault) = fixture();
    save(
        &vault,
        url_record_key(URL).unwrap(),
        URL.into(),
        "Saved page",
    )
    .unwrap();
    let item = only_item(&vault, "open");
    let set = |reading: Option<&str>, done| {
        super::set_reading(&vault, &item.id, &item.version, reading, done, || Ok(()))
    };
    let (_, first_done) = set(None, true).unwrap();
    let (_, reopened) = set(Some(&first_done), false).unwrap();
    let (_, second_done) = set(Some(&reopened), true).unwrap();
    assert_ne!(first_done, second_done);
    let journal = root
        .path()
        .join(layout::LATER_DIR)
        .join(".brauser-stash-reading")
        .join(&item.id);
    let missing = journal.join(format!("{first_done}.md"));
    let successor = journal.join(format!("{reopened}.md"));
    let retained = fs::read(&successor).unwrap();
    fs::remove_file(&missing).unwrap();

    let error = set(Some(&first_done), false).unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Unavailable>(),
        Some(Unavailable::Occupied)
    ));
    assert!(!missing.exists());
    assert_eq!(fs::read(successor).unwrap(), retained);
}

#[test]
fn a_full_reading_directory_refuses_to_publish_an_unreadable_transition() {
    let (root, vault) = fixture();
    save(
        &vault,
        url_record_key(URL).unwrap(),
        URL.into(),
        "Saved page",
    )
    .unwrap();
    let item = only_item(&vault, "open");
    let (_, done_version) =
        super::set_reading(&vault, &item.id, &item.version, None, true, || Ok(())).unwrap();
    let journal = root
        .path()
        .join(layout::LATER_DIR)
        .join(".brauser-stash-reading")
        .join(&item.id);
    fs::create_dir_all(&journal).unwrap();
    for index in 0..super::SCAN_LIMIT {
        fs::File::create(journal.join(format!("unrelated-{index}"))).unwrap();
    }
    assert!(only_item(&vault, "done").done);
    let error = super::set_reading(
        &vault,
        &item.id,
        &item.version,
        Some(&done_version),
        false,
        || Ok(()),
    )
    .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Unavailable>(),
        Some(Unavailable::ScanLimit)
    ));
    let transition = journal.join(format!("{done_version}.md"));
    assert!(!transition.exists());
    assert!(only_item(&vault, "done").done);

    fs::remove_file(journal.join("unrelated-0")).unwrap();
    let set = |check: &dyn Fn() -> anyhow::Result<()>| {
        super::set_reading(
            &vault,
            &item.id,
            &item.version,
            Some(&done_version),
            false,
            check,
        )
    };
    let late = journal.join("late");
    assert!(matches!(
        set(&|| {
            fs::File::create(&late)?;
            Ok(())
        })
        .unwrap_err()
        .downcast_ref::<Unavailable>(),
        Some(Unavailable::ScanLimit)
    ));
    assert!(!transition.exists());

    fs::remove_file(late).unwrap();
    let (_, version) = set(&|| {
        assert_eq!(fs::read_dir(&journal)?.count(), super::SCAN_LIMIT - 1);
        Ok(())
    })
    .unwrap();
    assert_ne!(version, done_version);
    assert!(transition.is_file());
    assert!(!only_item(&vault, "open").done);
}
