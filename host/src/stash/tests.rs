use std::{fs, path::Path};

use brauser_protocol::{ImportanceLevel, RecordKey, RecordKeyKind, StashItem, StorageConfig};

use super::{Unavailable, complete, list, save};
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
    let (mut items, next) = list(vault, state, "", None).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(next, None);
    items.pop().unwrap()
}

fn write_summary(vault: &Vault, key: &RecordKey) {
    let summary = format!(
        "---\nbrauser:\n  kind: summary\n  canonical_url: {}\n  url_id: {}\n\
         overview: \"Fixture overview\"\ndocument_type: \"Article\"\ncategory: \"Research\"\n\
         importance: medium\n---\n\nSummary body.\n",
        yaml_string(URL),
        yaml_string(&key.value)
    );
    assert!(matches!(
        vault.write_summary(key, URL, &summary).unwrap(),
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
        (false, true)
    );
    let first = only_item(&vault, "open");
    let later = root.path().join(layout::LATER_DIR);
    let entry = later.join(format!("{}.md", first.id));
    let receipt = fs::read(&entry).unwrap();

    assert_eq!(
        save(&vault, key.clone(), URL.into(), "First title").unwrap(),
        (true, true)
    );
    assert_eq!(
        save(
            &vault,
            key,
            "https://example.com/alternate/42".into(),
            "Alias title"
        )
        .unwrap(),
        (true, true)
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
        (false, true)
    );
    let pending = only_item(&vault, "open");
    assert_eq!(pending.summary, None);

    write_summary(&vault, &key);
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
        (true, false)
    );
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
    assert!(list(&vault, "all", "", None).unwrap().0.is_empty());
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
    fs::write(&summary, "Independently written summary").unwrap();

    let blocked = save(&vault, key, URL.into(), "New title").unwrap_err();
    assert!(matches!(
        blocked.downcast_ref(),
        Some(Unavailable::SummaryOccupied)
    ));
    assert_eq!(only_item(&vault, "open").summary, None);
    assert_eq!(
        fs::read_to_string(summary).unwrap(),
        "Independently written summary"
    );
}

#[test]
fn completion_survives_reopen_and_keeps_the_original_entry_and_summary() {
    let (root, vault) = fixture();
    let key = url_record_key(URL).unwrap();
    write_summary(&vault, &key);
    assert_eq!(
        save(&vault, key.clone(), URL.into(), "Article").unwrap(),
        (false, false)
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
    assert!(list(&reopened, "open", "", None).unwrap().0.is_empty());
    item.done = true;
    assert_eq!(only_item(&reopened, "done"), item);
    complete(&reopened, &item.id, &item.version).unwrap();
    assert_eq!(
        save(&reopened, key, URL.into(), "Article").unwrap(),
        (true, false)
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
    assert!(list(&vault, "all", "", None).unwrap().0.is_empty());
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
    assert!(list(&vault, "all", "", None).is_err());
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
        (false, true)
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
    let (items, _) = list(&vault, "open", "", None).unwrap();
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
    write_summary(&vault, &key);
    let summaries = root.path().join(layout::SUMMARIES_DIR);
    fs::rename(&summaries, root.path().join("other")).unwrap();
    symlink("other", summaries).unwrap();

    assert_eq!(only_item(&vault, "open").summary, None);
    let error = save(&vault, key, URL.into(), "Article").unwrap_err();
    assert!(matches!(
        error.downcast_ref(),
        Some(Unavailable::SummaryOccupied)
    ));
}
