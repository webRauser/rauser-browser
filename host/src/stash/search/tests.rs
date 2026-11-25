use std::{fs, path::Path};

use brauser_protocol::{RecordKey, RecordKeyKind, StorageConfig};

use super::*;
use crate::layout;
use crate::markdown::yaml_string;
use crate::stash::{digest, id, read, save};
use crate::vault::{selected_root_identity, url_record_key};

const FIRST: &str = "https://example.com/articles/first";
const SECOND: &str = "https://example.org/articles/second";

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

fn open(root: &Path) -> Vault {
    let identity = selected_root_identity(root).unwrap();
    Vault::open_checked(&storage(root), Some(&identity)).unwrap()
}

fn fixture() -> (tempfile::TempDir, Vault, RecordKey, RecordKey) {
    let temp = tempfile::tempdir().unwrap();
    let vault = open(temp.path());
    let first = url_record_key(FIRST).unwrap();
    let second = url_record_key(SECOND).unwrap();
    save(&vault, first.clone(), FIRST.into(), "Common title").unwrap();
    save(&vault, second.clone(), SECOND.into(), "Other title").unwrap();
    (temp, vault, first, second)
}

// Ordering is supplied by the fixture. Acquire and verify the receipt bytes
// just as the real list seam does without exercising its presentation sort.
fn checked(vault: &Vault, keys: &[&RecordKey]) -> Vec<Listed> {
    let dir = vault.stash_dir(false).unwrap().unwrap();
    keys.iter()
        .map(|key| {
            let id = id(key);
            let bytes = read(&dir, &format!("{id}.md")).unwrap().unwrap();
            Listed {
                version: digest(&bytes),
                entry: Entry::parse(&bytes, &id).unwrap(),
                id,
                pinned: false,
                done: false,
                reading_version: None,
            }
        })
        .collect()
}

fn write_summary(vault: &Vault, key: &RecordKey, url: &str, fields: &str, description: &str) {
    let identity = match key.kind {
        RecordKeyKind::Url => "url_id",
        RecordKeyKind::Artifact => "artifact_id",
    };
    let text = format!(
        "---\nbrauser:\n  kind: summary\n  canonical_url: {}\n  {identity}: {}\n\
         overview: \"Ordinary overview\"\ndocument_type: \"Article\"\n\
         {fields}---\n[Page](<{url}>)\n\n## Summary\n{description}\n\n\
         ## Assessment\nExcluded boilerplate\n",
        yaml_string(url),
        yaml_string(&key.value),
    );
    vault.write_summary(key, url, &text).unwrap();
}

fn limits(files: usize) -> Limits {
    Limits {
        files,
        elapsed: Duration::MAX,
        ..Limits::default()
    }
}

fn scan(
    vault: &Vault,
    entries: &[Listed],
    query: &str,
    filters: &Filters<'_>,
    after: Option<&Boundary>,
    limits: Limits,
) -> Result<Batch> {
    let options = ScanOptions {
        state: "all",
        query,
        filters: filters.clone(),
        pin_order: None,
        after: after.map(|after| (after.id.as_str(), after.revision.as_str())),
    };
    super::scan(vault, entries, &options, limits)
}

#[test]
fn empty_limited_batch_resumes_to_a_content_only_summary_hit() {
    let (_temp, vault, first, second) = fixture();
    write_summary(
        &vault,
        &second,
        SECOND,
        "read_scope: partial\n",
        "A sparse quartz signal.",
    );
    let entries = checked(&vault, &[&first, &second]);
    let filters = Filters {
        document_type: Some("article"),
        coverage: Some(StashSearchCoverage::Partial),
        ..Filters::default()
    };
    let batch = scan(&vault, &entries, "QUARTZ", &filters, None, limits(2)).unwrap();
    assert!(batch.hits.is_empty());
    let Stop::Limited {
        reason: StashSearchLimit::Files,
        after: Some(after),
    } = batch.stop
    else {
        panic!("expected an empty, resumable batch");
    };
    assert_eq!(after.id, id(&first));
    let batch = scan(
        &vault,
        &checked(&vault, &[&first, &second]),
        "QUARTZ",
        &filters,
        Some(&after),
        limits(2),
    )
    .unwrap();
    assert_eq!(batch.stop, Stop::Exhausted);
    assert_eq!(batch.hits.len(), 1);
    assert_eq!(entries[batch.hits[0].position].id, id(&second));
    assert_eq!(
        batch.hits[0].matched,
        Some(StashSearchMatch {
            source: Source::Summary,
            snippet: Some("A sparse quartz signal.".into()),
        })
    );
    for (term, source) in [
        ("example.org", Source::Source),
        ("Other title", Source::Title),
    ] {
        let batch = scan(&vault, &entries, term, &Filters::default(), None, limits(4)).unwrap();
        assert_eq!(batch.hits[0].matched.as_ref().unwrap().source, source);
    }

    for term in ["read_scope", "Assessment", "boilerplate"] {
        let batch = scan(&vault, &entries, term, &Filters::default(), None, limits(4)).unwrap();
        assert!(batch.hits.is_empty(), "{term}");
        assert_eq!(batch.stop, Stop::Exhausted);
    }
}

#[test]
fn bytes_and_elapsed_limits_preserve_the_last_completed_receipt() {
    let (temp, vault, first, second) = fixture();
    write_summary(&vault, &second, SECOND, "", "No matching words here.");
    crate::note::save_keyed_note(
        &vault,
        SECOND,
        &second,
        "Note",
        "Late-only keyword",
        "missing",
    )
    .unwrap();
    let summary_len = fs::metadata(
        temp.path()
            .join(vault.summary_relative_path(&second, SECOND).unwrap()),
    )
    .unwrap()
    .len();
    let entries = checked(&vault, &[&first, &second]);
    let filters = Filters::default();
    let batch = scan(
        &vault,
        &entries,
        "keyword",
        &filters,
        None,
        Limits {
            bytes: summary_len + 1,
            ..limits(4)
        },
    )
    .unwrap();
    let Stop::Limited {
        reason: StashSearchLimit::Bytes,
        after: Some(after),
    } = batch.stop
    else {
        panic!("expected the pair to exceed the byte allowance");
    };
    assert!(batch.hits.is_empty());
    assert_eq!(after.id, id(&first));

    let batch = scan(
        &vault,
        &entries,
        "keyword",
        &filters,
        Some(&after),
        Limits {
            elapsed: Duration::ZERO,
            ..limits(4)
        },
    )
    .unwrap();
    assert_eq!(
        batch.stop,
        Stop::Limited {
            reason: StashSearchLimit::Elapsed,
            after: Some(after.clone())
        }
    );
    let batch = scan(
        &vault,
        &entries,
        "keyword",
        &filters,
        Some(&after),
        limits(2),
    )
    .unwrap();
    assert_eq!(batch.stop, Stop::Exhausted);
    assert_eq!(batch.hits[0].matched.as_ref().unwrap().source, Source::Note);
}

#[test]
fn oversized_and_wrong_identity_content_cannot_supply_hits_or_filters() {
    let (temp, vault, first, second) = fixture();
    let payload = "Hidden ownership bait";
    write_summary(&vault, &first, FIRST, "read_scope: whole\n", payload);
    let owned = temp
        .path()
        .join(vault.summary_relative_path(&first, FIRST).unwrap());
    let wrong = temp
        .path()
        .join(vault.summary_relative_path(&second, SECOND).unwrap());
    fs::copy(&owned, wrong).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(owned)
        .unwrap()
        .set_len(MAX_READ_BYTES)
        .unwrap();
    let body = "A valid note marker.";
    crate::note::save_keyed_note(
        &vault,
        SECOND,
        &second,
        "Private note title",
        body,
        "missing",
    )
    .unwrap();
    let entries = checked(&vault, &[&first, &second]);
    let filters = Filters::default();
    let batch = scan(&vault, &entries, payload, &filters, None, limits(4)).unwrap();
    assert!(batch.hits.is_empty());
    assert_eq!(batch.stop, Stop::Exhausted);
    let batch = scan(
        &vault,
        &entries,
        "marker",
        &Filters {
            document_type: Some("article"),
            coverage: Some(StashSearchCoverage::Whole),
            ..Filters::default()
        },
        None,
        limits(4),
    )
    .unwrap();
    assert!(batch.hits.is_empty());
    assert_eq!(
        scan(&vault, &entries, "marker", &filters, None, limits(4))
            .unwrap()
            .hits
            .len(),
        1
    );

    let path = temp
        .path()
        .join(vault.note_relative_path(&second, SECOND).unwrap());
    let note = fs::read_to_string(&path).unwrap();
    for unowned in [
        note.replace(SECOND, FIRST),
        note.replace(&second.value, &first.value),
    ] {
        fs::write(&path, unowned).unwrap();
        assert!(
            scan(&vault, &entries, "marker", &filters, None, limits(4))
                .unwrap()
                .hits
                .is_empty()
        );
    }
}

#[test]
fn record_aliases_share_paths_without_duplicate_hits_and_repeated_scope_is_unknown() {
    let (_temp, vault, _, _) = fixture();
    let key = RecordKey {
        kind: RecordKeyKind::Artifact,
        value: "example:example.com/document".into(),
    };
    let alias = "https://example.com/alternate/document";
    save(&vault, key.clone(), FIRST.into(), "Document").unwrap();
    assert!(
        save(&vault, key.clone(), alias.into(), "Alias")
            .unwrap()
            .already_saved
    );
    assert_eq!(
        vault.note_relative_path(&key, alias).unwrap(),
        vault.note_relative_path(&key, FIRST).unwrap()
    );
    assert_eq!(
        vault.summary_relative_path(&key, alias).unwrap(),
        vault.summary_relative_path(&key, FIRST).unwrap()
    );
    crate::note::save_keyed_note(&vault, alias, &key, "Note", "Shared keyword", "missing").unwrap();
    write_summary(
        &vault,
        &key,
        alias,
        "read_scope: whole\nread_scope: whole\n",
        "Shared keyword",
    );
    let entries = checked(&vault, &[&key, &key]);
    let filters = Filters {
        source_host: Some("EXAMPLE.COM"),
        document_type: Some("article"),
        ..Filters::default()
    };
    let batch = scan(&vault, &entries, "keyword", &filters, None, limits(2)).unwrap();
    assert_eq!(batch.stop, Stop::Exhausted);
    assert_eq!(batch.hits.len(), 1);
    assert_eq!(
        batch.hits[0].matched.as_ref().unwrap().source,
        Source::Summary
    );

    let scope = Filters {
        coverage: Some(StashSearchCoverage::Whole),
        ..filters
    };
    assert!(
        scan(&vault, &entries, "keyword", &scope, None, limits(2))
            .unwrap()
            .hits
            .is_empty()
    );
    let other_host = Filters {
        source_host: Some("example.org"),
        ..Filters::default()
    };
    assert!(
        scan(&vault, &entries, "keyword", &other_host, None, limits(2))
            .unwrap()
            .hits
            .is_empty()
    );
}

#[test]
fn changed_home_order_and_receipt_bytes_reject_the_boundary() {
    let (temp, vault, first, second) = fixture();
    write_summary(&vault, &first, FIRST, "", "Ordinary content.");
    let entries = checked(&vault, &[&first, &second]);
    let filters = Filters::default();
    let batch = scan(&vault, &entries, "missing", &filters, None, limits(2)).unwrap();
    let Stop::Limited {
        after: Some(after), ..
    } = batch.stop
    else {
        panic!("missing boundary");
    };
    let (other_temp, other_vault, other_first, other_second) = fixture();
    let relative = Path::new(layout::LATER_DIR).join(format!("{}.md", id(&first)));
    fs::copy(
        temp.path().join(&relative),
        other_temp.path().join(&relative),
    )
    .unwrap();
    let other_entries = checked(&other_vault, &[&other_first, &other_second]);
    assert_eq!(other_entries[0].version, entries[0].version);
    let rejects = |vault, entries: &[Listed]| {
        assert!(
            matches!(scan(vault, entries, "missing", &filters, Some(&after), limits(2)), Err(error) if error.is::<Unavailable>())
        );
    };
    rejects(&other_vault, &other_entries);
    rejects(&vault, &checked(&vault, &[&second, &first]));

    let summaries = temp.path().join(layout::SUMMARIES_DIR);
    let previous_summaries = temp.path().join("previous-summaries");
    fs::rename(&summaries, &previous_summaries).unwrap();
    fs::create_dir(&summaries).unwrap();
    rejects(&vault, &entries);
    fs::remove_dir(&summaries).unwrap();
    fs::rename(previous_summaries, summaries).unwrap();

    let entry = Entry {
        key: first.clone(),
        url: FIRST.into(),
        title: "Edited title".into(),
        saved_at: entries[0].entry.saved_at.clone(),
    };
    fs::write(
        temp.path()
            .join(layout::LATER_DIR)
            .join(format!("{}.md", id(&first))),
        entry.render(),
    )
    .unwrap();
    rejects(&vault, &checked(&vault, &[&first, &second]));
}

#[test]
fn snippets_are_short_literal_text_even_for_late_and_multibyte_matches() {
    let (_temp, vault, first, _) = fixture();
    let text = format!(
        "{}\u{202e}<img src=about:blank> QUARTZ {}",
        "İ".repeat(500),
        "薬".repeat(500)
    );
    crate::note::save_keyed_note(&vault, FIRST, &first, "Note", &text, "missing").unwrap();
    let entries = checked(&vault, &[&first]);
    let batch = scan(
        &vault,
        &entries,
        "quartz",
        &Filters::default(),
        None,
        limits(2),
    )
    .unwrap();
    let snippet = batch.hits[0]
        .matched
        .as_ref()
        .unwrap()
        .snippet
        .as_ref()
        .unwrap();
    assert!(snippet.contains("<img src=about:blank> QUARTZ"));
    assert!(!snippet.contains('\u{202e}'));
    assert_eq!(snippet.chars().count(), SNIPPET_CHARS);
}

#[cfg(unix)]
#[test]
fn symlinked_and_replaced_content_cannot_bypass_inspection() {
    let (temp, vault, first, _) = fixture();
    write_summary(&vault, &first, FIRST, "", "Original owned content.");
    let scope = vault.stash_search_scope().unwrap();
    let snapshot = scope
        .inspect_summary(&first, FIRST)
        .unwrap()
        .present()
        .unwrap();
    let path = temp
        .path()
        .join(vault.summary_relative_path(&first, FIRST).unwrap());
    let target = temp.path().join("other.md");
    fs::rename(&path, &target).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(snapshot.read_summary(&first).is_err());
    assert!(matches!(
        scope.inspect_summary(&first, FIRST).unwrap(),
        Inspection::Unowned
    ));
    fs::remove_file(&path).unwrap();
    fs::copy(&target, path).unwrap();
    assert!(snapshot.read_summary(&first).is_err());
}

#[cfg(windows)]
#[test]
fn held_windows_content_excludes_writes_and_moves() {
    let (temp, vault, first, _) = fixture();
    write_summary(&vault, &first, FIRST, "", "Owned content");
    let path = temp
        .path()
        .join(vault.summary_relative_path(&first, FIRST).unwrap());
    let scope = vault.stash_search_scope().unwrap();
    let held = scope
        .inspect_summary(&first, FIRST)
        .unwrap()
        .present()
        .unwrap();
    assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
    assert!(fs::rename(&path, path.with_extension("moved")).is_err());
    assert!(matches!(
        held.read_summary(&first).unwrap(),
        FoundSummary::Owned { .. }
    ));
    drop(held);
    assert!(fs::OpenOptions::new().write(true).open(&path).is_ok());
}

#[test]
fn inaccessible_notes_do_not_hide_title_or_owned_summary_results() {
    let (temp, vault, first, second) = fixture();
    let notes = temp.path().join(layout::NOTES_DIR);
    if notes.is_dir() {
        fs::remove_dir(&notes).unwrap();
    }
    fs::write(&notes, "This fixture is not a notes directory.").unwrap();
    write_summary(
        &vault,
        &second,
        SECOND,
        "read_scope: partial\n",
        "A quartz signal.",
    );
    let entries = checked(&vault, &[&first, &second]);
    for (term, expected) in [("Common title", Source::Title), ("quartz", Source::Summary)] {
        let batch = scan(&vault, &entries, term, &Filters::default(), None, limits(4)).unwrap();
        assert!(batch.availability.notes_unavailable);
        assert_eq!(batch.hits.len(), 1);
        assert_eq!(batch.hits[0].matched.as_ref().unwrap().source, expected);
    }
}

#[cfg(windows)]
#[test]
fn sharing_refusal_in_one_note_keeps_the_checked_summary_result() {
    use std::os::windows::fs::OpenOptionsExt;
    let (temp, vault, first, second) = fixture();
    crate::note::save_keyed_note(
        &vault,
        FIRST,
        &first,
        "Note",
        "Unreachable quartz",
        "missing",
    )
    .unwrap();
    let path = temp
        .path()
        .join(vault.note_relative_path(&first, FIRST).unwrap());
    let _lock = std::fs::OpenOptions::new()
        .write(true)
        .share_mode(0)
        .open(path)
        .unwrap();
    write_summary(
        &vault,
        &second,
        SECOND,
        "read_scope: partial\n",
        "A quartz signal.",
    );
    let entries = checked(&vault, &[&first, &second]);
    let batch = scan(
        &vault,
        &entries,
        "quartz",
        &Filters::default(),
        None,
        limits(4),
    )
    .unwrap();
    assert!(batch.availability.notes_unavailable);
    assert_eq!(batch.hits.len(), 1);
    assert_eq!(
        batch.hits[0].matched.as_ref().unwrap().source,
        Source::Summary
    );
}

#[cfg(unix)]
#[test]
fn unreadable_summaries_do_not_hide_title_or_owned_note_results() {
    use std::os::unix::fs::PermissionsExt;

    if rustix::process::geteuid().is_root() {
        eprintln!("POSIX file permissions do not block a root process");
        return;
    }
    let (temp, vault, first, second) = fixture();
    write_summary(&vault, &first, FIRST, "", "An inaccessible summary.");
    crate::note::save_keyed_note(&vault, SECOND, &second, "Note", "A quartz note.", "missing")
        .unwrap();
    let entries = checked(&vault, &[&first, &second]);
    let summaries = temp.path().join(layout::SUMMARIES_DIR);
    let permissions = fs::metadata(&summaries).unwrap().permissions();
    fs::set_permissions(&summaries, fs::Permissions::from_mode(0o000)).unwrap();
    let filters = Filters::default();
    let title = scan(&vault, &entries, "Common title", &filters, None, limits(4));
    let note = scan(&vault, &entries, "quartz", &filters, None, limits(4));
    fs::set_permissions(&summaries, permissions).unwrap();

    for (batch, expected) in [(title, Source::Title), (note, Source::Note)] {
        let batch = batch.unwrap();
        assert_eq!(batch.hits.len(), 1);
        assert_eq!(batch.hits[0].matched.as_ref().unwrap().source, expected);
        assert_eq!(batch.hits[0].issue, Some(StashSummaryIssue::Unavailable));
        assert!(batch.availability.summaries_unavailable);
    }
}

#[test]
fn search_returns_visible_text_from_a_neutralized_summary() {
    let (_temp, vault, first, _) = fixture();
    let prose = "The price is $500 and the <budget> is approved.";
    let markdown = crate::markdown::neutralize_remote(prose);
    write_summary(&vault, &first, FIRST, "", &markdown);
    let entries = checked(&vault, &[&first]);
    for query in ["$500", "<budget>", "price"] {
        let batch = scan(
            &vault,
            &entries,
            query,
            &Filters::default(),
            None,
            limits(2),
        )
        .unwrap();
        let matched = batch.hits.first().and_then(|hit| hit.matched.as_ref());
        assert_eq!(
            matched,
            Some(&StashSearchMatch {
                source: Source::Summary,
                snippet: Some(prose.into())
            }),
            "{query}",
        );
    }
}
