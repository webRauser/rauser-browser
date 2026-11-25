//! Create-only Stash entries, reading transitions and independent pins.
use std::{
    cmp::Reverse,
    io::{self, Write},
};

use anyhow::{Context, Result, bail};
use brauser_protocol::{
    ImportanceLevel, RecordKey, RecordKeyKind, StashItem, StashPin, StashSearchProgress,
    StashSearchQuery, StashSummary, StashSummaryIssue,
};
use cap_std::fs::{Dir, OpenOptions};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    folder_identity::directory_identity,
    markdown::{inline, yaml_string},
    presentation::plain_line,
    summary::recorded_read_scope,
    vault::{
        FoundSummary, TempFileCleanup, Vault, note_filename, read_inspected_occupant,
        sync_directory,
    },
};

const ENTRY_PREFIX: &str = "---\nbrauser:\n  kind: stash\n  format: 1\n";
// A URL is bounded before formatting. JSON and Markdown escaping can still
// expand it substantially, so apply one higher limit on both reads and writes.
const MAX_ENTRY_BYTES: u64 = 256 * 1024;
const SCAN_LIMIT: usize = 10_000;
const PAGE_SIZE: usize = 20;

mod pins;
mod reading;
use pins::Pins;

#[derive(Debug)]
pub(crate) enum Unavailable {
    Occupied,
    PinHistory,
    PinLockChanged,
    PinOrderChanged,
    SearchChanged,
    Changed,
    ScanLimit,
}

impl std::fmt::Display for Unavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Occupied => "An unrelated or edited file occupies this Stash entry's name. Move it aside and try again.",
            Self::PinHistory => "Stash pin history is occupied, changed or damaged. Restore the original pin files in the selected home before retrying.",
            Self::PinLockChanged => "The configuration lock changed. Refresh Stash before continuing.",
            Self::SearchChanged => "Stash results changed. Restart the search to continue.",
            Self::PinOrderChanged => "Stash pin order changed. Refresh Stash before loading more.",
            Self::Changed => "This Stash entry changed. Refresh Stash before continuing.",
            Self::ScanLimit => "Stash exceeds the number of files Brauser can scan.",
        })
    }
}

impl std::error::Error for Unavailable {}

struct Entry {
    key: RecordKey,
    url: String,
    title: String,
    saved_at: String,
}

impl Entry {
    fn id(&self) -> String {
        id(&self.key)
    }

    fn render(&self) -> String {
        let kind = match self.key.kind {
            RecordKeyKind::Url => "url",
            RecordKeyKind::Artifact => "artifact",
        };
        let fields = format!(
            "{ENTRY_PREFIX}  record_key_kind: {kind}\n  record_key_value: {}\n  canonical_url: {}\ntitle: {}\nsaved_at: {}",
            metadata(&self.key.value),
            metadata(&self.url),
            metadata(&self.title),
            metadata(&self.saved_at),
        );
        let body = format!(
            "\n# {}\n\nSource: {}\n\nSaved to Brauser Stash on {}.\n",
            inline(&self.title, 300),
            inline(&self.url, 8192),
            self.saved_at,
        );
        let checksum = entry_checksum(&fields, &body);
        format!("{fields}\nreceipt_sha256: {checksum}\n---\n{body}")
    }

    fn parse(contents: &[u8], name: &str) -> Option<Self> {
        let text = std::str::from_utf8(contents).ok()?;
        let rest = text.strip_prefix(ENTRY_PREFIX)?;
        let (header, body) = rest.split_once("\n---\n")?;
        let (fields, checksum) = header.rsplit_once("\nreceipt_sha256: ")?;
        // Verify the saved bytes without depending on the current Markdown renderer.
        let owned_fields = text.get(..ENTRY_PREFIX.len() + fields.len())?;
        if entry_checksum(owned_fields, body) != checksum {
            return None;
        }
        let mut lines = fields.lines();
        let kind = match lines.next()?.strip_prefix("  record_key_kind: ")? {
            "url" => RecordKeyKind::Url,
            "artifact" => RecordKeyKind::Artifact,
            _ => return None,
        };
        let value = json_field(lines.next()?, "  record_key_value: ")?;
        let url = json_field(lines.next()?, "  canonical_url: ")?;
        let title = json_field(lines.next()?, "title: ")?;
        let saved_at = json_field(lines.next()?, "saved_at: ")?;
        let entry = Self {
            key: RecordKey { kind, value },
            url,
            title,
            saved_at,
        };
        if entry.title.is_empty()
            || plain_line(&entry.title, 300) != entry.title
            || entry.url.len() > 8192
            || crate::capture::canonical_url(&entry.url, &[]).ok().as_ref() != Some(&entry.url)
            || note_filename(&entry.key, &entry.url).is_err()
            || !valid_timestamp(&entry.saved_at)
            || entry.id() != name
            || lines.next().is_some()
        {
            return None;
        }
        Some(entry)
    }
}

fn valid_timestamp(value: &str) -> bool {
    value.len() <= 64 && OffsetDateTime::parse(value, &Rfc3339).is_ok()
}

fn metadata(value: &str) -> String {
    yaml_string(value)
        .replace('`', "\\u0060")
        .replace('$', "\\u0024")
        .replace('~', "\\u007e")
}

fn json_field(line: &str, prefix: &str) -> Option<String> {
    serde_json::from_str(line.strip_prefix(prefix)?).ok()
}

fn entry_checksum(fields: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(fields.as_bytes());
    hasher.update(b"\n---\n");
    hasher.update(body.as_bytes());
    hex::encode(hasher.finalize())
}

fn digest(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn id(key: &RecordKey) -> String {
    let namespace = match key.kind {
        RecordKeyKind::Url => "brauser.stash.url:",
        RecordKeyKind::Artifact => "brauser.stash.artifact:",
    };
    digest(format!("{namespace}{}", key.value).as_bytes())
}

pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
}

fn read(dir: &Dir, name: &str) -> Result<Option<Vec<u8>>> {
    read_bounded(dir, name, MAX_ENTRY_BYTES)
}

fn read_bounded(dir: &Dir, name: &str, max_bytes: u64) -> Result<Option<Vec<u8>>> {
    let inspected = match dir.symlink_metadata(name) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if inspected.file_type().is_symlink() || !inspected.is_file() || inspected.len() > max_bytes {
        return Err(Unavailable::Occupied.into());
    }
    let bytes = read_inspected_occupant(dir, name.as_ref(), &inspected)?
        .filter(|bytes| bytes.len() as u64 <= max_bytes)
        .ok_or(Unavailable::Occupied)?;
    Ok(Some(bytes))
}

fn publish(dir: &Dir, name: &str, contents: &str) -> Result<()> {
    publish_checked(dir, name, contents, || Ok(()))
}

fn publish_checked(
    dir: &Dir,
    name: &str,
    contents: &str,
    before_link: impl FnOnce() -> Result<()>,
) -> Result<()> {
    if contents.len() as u64 > MAX_ENTRY_BYTES {
        bail!("rendered Stash receipt exceeds its size limit");
    }
    let temporary = format!(".stash-{}.tmp", Uuid::new_v4());
    let mut file = dir.open_with(&temporary, OpenOptions::new().write(true).create_new(true))?;
    let _cleanup = TempFileCleanup::new(dir, &temporary);
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    drop(file);
    before_link()?;
    match dir.hard_link(&temporary, dir, name) {
        Ok(()) => Ok(sync_directory(dir)?),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Err(Unavailable::Changed.into())
        }
        Err(error) => Err(error.into()),
    }
}

fn done_text(id: &str, version: &str) -> String {
    format!(
        "---\nbrauser:\n  kind: stash_done\n  format: 1\n  stash_id: \"{id}\"\n  entry_sha256: \"{version}\"\n---\n\nMarked done in Brauser Stash.\n"
    )
}

fn is_done(dir: &Dir, id: &str, version: &str) -> Result<bool> {
    let Some(bytes) = read(dir, &format!("{id}.done.md"))? else {
        return Ok(false);
    };
    Ok(bytes == done_text(id, version).as_bytes())
}

fn summary_issue(found: &Result<FoundSummary>) -> Option<StashSummaryIssue> {
    match found {
        Ok(FoundSummary::Unowned) => Some(StashSummaryIssue::Conflict),
        Err(_) => Some(StashSummaryIssue::Unavailable),
        _ => None,
    }
}

fn summary(found: FoundSummary, key: &RecordKey) -> Option<StashSummary> {
    let FoundSummary::Owned {
        linked,
        summarized_at,
        bytes,
        ..
    } = found
    else {
        return None;
    };
    let frontmatter = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| text.strip_prefix("---\n"))
        .and_then(|text| text.split_once("\n---\n"))
        .map_or("", |(frontmatter, _)| frontmatter);
    let field = |prefix: &str, max| {
        let mut lines = frontmatter.lines().filter(|line| line.starts_with(prefix));
        let value = plain_line(&json_field(lines.next()?, prefix)?, max);
        (lines.next().is_none() && !value.is_empty()).then_some(value)
    };
    let mut importance = frontmatter
        .lines()
        .filter_map(|line| line.strip_prefix("importance: "));
    let importance = match (importance.next(), importance.next()) {
        (Some("high"), None) => Some(ImportanceLevel::High),
        (Some("medium"), None) => Some(ImportanceLevel::Medium),
        (Some("low"), None) => Some(ImportanceLevel::Low),
        _ => None,
    };
    // Treat repeated scope fields as ambiguous even if the first is recognized.
    let read_scope = recorded_read_scope(&bytes, key)
        .filter(|_| {
            frontmatter
                .lines()
                .filter(|line| line.starts_with("read_scope:"))
                .nth(1)
                .is_none()
        })
        .map(Into::into);
    Some(StashSummary {
        path: linked,
        overview: field("overview: ", 2400),
        document_type: field("document_type: ", 64),
        category: field("category: ", 64),
        importance,
        summarized_at: summarized_at.filter(|value| valid_timestamp(value)),
        read_scope,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SavedPage {
    pub(crate) already_saved: bool,
    pub(crate) needs_summary: bool,
    pub(crate) summary_issue: Option<StashSummaryIssue>,
}

pub(crate) fn save(vault: &Vault, key: RecordKey, url: String, title: &str) -> Result<SavedPage> {
    note_filename(&key, &url)?;
    let dir = vault
        .stash_dir(true)?
        .context("the Stash folder disappeared")?;
    let id = id(&key);
    let name = format!("{id}.md");
    let (entry, already_saved, done) = if let Some(bytes) = read(&dir, &name)? {
        let entry = Entry::parse(&bytes, &id)
            .filter(|entry| entry.key == key)
            .ok_or(Unavailable::Occupied)?;
        let version = digest(&bytes);
        let journal = reading::directory(&dir, false)?;
        let done = reading::current(
            journal.as_ref(),
            &id,
            &version,
            is_done(&dir, &id, &version)?,
        )?
        .done;
        sync_directory(&dir)?;
        (entry, true, done)
    } else {
        let title = plain_line(title, 300);
        let entry = Entry {
            key,
            title: if title.is_empty() {
                url::Url::parse(&url)?
                    .host_str()
                    .context("the page URL has no host")?
                    .into()
            } else {
                title
            },
            url,
            saved_at: OffsetDateTime::now_utc().format(&Rfc3339)?,
        };
        (entry, false, false)
    };
    if !already_saved {
        publish(&dir, &name, &entry.render())?;
    }
    let (needs_summary, summary_issue) = if done {
        (false, None)
    } else {
        // Summary lookup can fail independently of the now-durable entry.
        let found = vault.find_stash_summary(&entry.key, &entry.url);
        (
            matches!(found, Ok(FoundSummary::Absent)),
            summary_issue(&found),
        )
    };
    Ok(SavedPage {
        already_saved,
        needs_summary,
        summary_issue,
    })
}

pub(crate) fn complete(vault: &Vault, id: &str, version: &str) -> Result<()> {
    set_reading(vault, id, version, None, true, || Ok(())).map(|_| ())
}

pub(crate) fn set_reading(
    vault: &Vault,
    id: &str,
    version: &str,
    expected_reading: Option<&str>,
    done: bool,
    check_lock: impl Fn() -> Result<()>,
) -> Result<(bool, String)> {
    let dir = vault.stash_dir(false)?.ok_or(Unavailable::Changed)?;
    let entry_name = format!("{id}.md");
    let bytes = read(&dir, &entry_name)?.ok_or(Unavailable::Changed)?;
    if Entry::parse(&bytes, id).is_none() || digest(&bytes) != version {
        bail!(Unavailable::Changed);
    }
    let marker_name = format!("{id}.done.md");
    let completion = done_text(id, version);
    let legacy = match read(&dir, &marker_name)? {
        Some(bytes) if bytes == completion.as_bytes() => true,
        Some(_) => bail!(Unavailable::Occupied),
        None => false,
    };
    let journal = reading::directory(&dir, false)?;
    let current = reading::current(journal.as_ref(), id, version, legacy)?;
    if let Some(expected) = expected_reading
        && expected != current.version
        && !(current.done == done
            && (current.previous.as_deref() == Some(expected)
                || (legacy
                    && current.previous.is_none()
                    && expected == reading::baseline(id, version, false).version)))
    {
        bail!(Unavailable::Changed);
    }
    let identity = directory_identity(&dir, None)?;
    let check_entry = || -> Result<Dir> {
        check_lock()?;
        let still = vault.stash_dir(false)?.ok_or(Unavailable::Changed)?;
        if directory_identity(&still, None)? != identity
            || read(&still, &entry_name)?.as_deref() != Some(bytes.as_slice())
        {
            bail!(Unavailable::Changed);
        }
        Ok(still)
    };
    if current.done == done {
        let still = check_entry()?;
        let committed_dir = if let Some(journal) = &journal
            && current.previous.is_some()
        {
            let attached = reading::directory(&still, false)?.ok_or(Unavailable::Changed)?;
            if directory_identity(&attached, None)? != directory_identity(journal, None)? {
                bail!(Unavailable::Changed);
            }
            attached
        } else {
            still
        };
        sync_directory(&committed_dir)?;
        return Ok((done, current.version));
    }

    if !legacy {
        // A first completion still writes the exact Done receipt used by
        // existing Stash data. Later operations preserve it as history.
        publish_checked(&dir, &marker_name, &completion, || {
            check_entry().map(|_| ())
        })?;
        return Ok((true, reading::baseline(id, version, true).version));
    }

    let journal = match journal {
        Some(dir) => dir,
        None => reading::directory(&check_entry()?, true)?.ok_or(Unavailable::Changed)?,
    };
    let journal_identity = directory_identity(&journal, None)?;
    let updated = reading::append(&journal, id, version, current, || {
        let still = check_entry()?;
        let attached = reading::directory(&still, false)?.ok_or(Unavailable::Changed)?;
        if directory_identity(&attached, None)? != journal_identity
            || read(&still, &marker_name)?.as_deref() != Some(completion.as_bytes())
        {
            bail!(Unavailable::Changed);
        }
        Ok(())
    })?;
    Ok((updated.done, updated.version))
}

pub(crate) fn set_pin(
    vault: &Vault,
    id: &str,
    version: &str,
    expected_pin_version: &str,
    pinned: bool,
    check_lock: impl Fn() -> Result<()>,
) -> Result<StashPin> {
    let pins = Pins::load(vault)?;
    let dir = vault.stash_dir(false)?.ok_or(Unavailable::Changed)?;
    let bytes = read(&dir, &format!("{id}.md"))?.ok_or(Unavailable::Changed)?;
    if Entry::parse(&bytes, id).is_none() || digest(&bytes) != version {
        bail!(Unavailable::Changed);
    }
    pins.set(vault, id, version, expected_pin_version, pinned, check_lock)
}

struct Listed {
    id: String,
    version: String,
    entry: Entry,
    pinned: bool,
    done: bool,
    reading_version: Option<String>,
}

pub(crate) struct ListPage {
    pub(crate) items: Vec<StashItem>,
    pub(crate) next: Option<String>,
    pub(crate) pin_order: Option<String>,
    pub(crate) search_progress: Option<StashSearchProgress>,
}

#[cfg(test)]
pub(crate) fn list(
    vault: &Vault,
    state: &str,
    query: &str,
    after: Option<&str>,
    include_pin: bool,
    expected_pin_order: Option<&str>,
) -> Result<ListPage> {
    list_using(
        vault,
        ListOptions {
            state,
            query,
            after,
            include_pin,
            expected_pin_order,
            search: None,
            include_reading: false,
        },
    )
}

pub(crate) struct ListOptions<'a> {
    pub(crate) state: &'a str,
    pub(crate) query: &'a str,
    pub(crate) after: Option<&'a str>,
    pub(crate) include_pin: bool,
    pub(crate) expected_pin_order: Option<&'a str>,
    pub(crate) search: Option<&'a StashSearchQuery>,
    pub(crate) include_reading: bool,
}

pub(crate) fn list_using(vault: &Vault, options: ListOptions<'_>) -> Result<ListPage> {
    let ListOptions {
        state,
        query,
        after,
        include_pin,
        expected_pin_order,
        search,
        include_reading,
    } = options;
    let query = query.trim().to_lowercase();
    let pins = include_pin.then(|| Pins::load(vault)).transpose()?;
    let pin_order = if let Some(pins) = &pins {
        let home = directory_identity(vault.stash_pin_parent(), None)?;
        // Pin mutations change the history head even if the final order
        // equals an older one. Reuse the same identity-checked home handle.
        let scope = serde_json::to_vec(&(
            "brauser.stash.pin.order.v1",
            home,
            state,
            &query,
            pins.order_version(),
        ))?;
        let order = digest(&scope);
        if after.is_some() && expected_pin_order != Some(order.as_str()) {
            bail!(Unavailable::PinOrderChanged);
        }
        Some(order)
    } else {
        None
    };
    let dir = vault.stash_dir(false)?;
    let journal = dir
        .as_ref()
        .map(|dir| reading::directory(dir, false))
        .transpose()?
        .flatten();
    let mut entries = match &dir {
        Some(dir) => list_entries(dir, pins.as_ref())?,
        None => Vec::new(),
    };
    if let Some(search) = search {
        if let Some(dir) = &dir {
            for row in &mut entries {
                (row.done, row.reading_version) = listed_reading(
                    dir,
                    journal.as_ref(),
                    &row.id,
                    &row.version,
                    include_reading,
                )?;
            }
        }
        return search::list(
            vault,
            entries,
            pins.as_ref(),
            pin_order,
            search::Request {
                state,
                query: &query,
                after,
                filters: search,
            },
        );
    }
    let Some(dir) = dir else {
        if after.is_some() {
            bail!(Unavailable::Changed);
        }
        return Ok(ListPage {
            items: Vec::new(),
            next: None,
            pin_order,
            search_progress: None,
        });
    };
    let start = match after {
        Some(after) => {
            entries
                .iter()
                .position(|item| item.id == after)
                .ok_or(Unavailable::Changed)?
                + 1
        }
        None => 0,
    };
    let mut items = Vec::new();
    for Listed {
        id, version, entry, ..
    } in entries.into_iter().skip(start)
    {
        if !query.is_empty()
            && !entry.title.to_lowercase().contains(&query)
            && !entry.url.to_lowercase().contains(&query)
        {
            continue;
        }
        let (done, reading_version) =
            listed_reading(&dir, journal.as_ref(), &id, &version, include_reading)?;
        if !matches_state(done, state) {
            continue;
        }
        if items.len() == PAGE_SIZE {
            let next = items.last().map(|item: &StashItem| item.id.clone());
            return Ok(ListPage {
                items,
                next,
                pin_order,
                search_progress: None,
            });
        }
        let found = vault.find_stash_summary(&entry.key, &entry.url);
        let summary_issue = summary_issue(&found);
        let summary = found.ok().and_then(|found| summary(found, &entry.key));
        let pin = pins
            .as_ref()
            .map(|pins| pins.view(&id, &version))
            .transpose()?;
        items.push(StashItem {
            id,
            version,
            title: entry.title,
            url: entry.url,
            saved_at: entry.saved_at,
            done,
            reading_version,
            pin,
            search_match: None,
            summary,
            summary_issue,
        });
    }
    Ok(ListPage {
        items,
        next: None,
        pin_order,
        search_progress: None,
    })
}

fn list_entries(dir: &Dir, pins: Option<&Pins>) -> Result<Vec<Listed>> {
    let mut entries = Vec::new();
    for (n, file) in dir.entries()?.enumerate() {
        if n >= SCAN_LIMIT {
            bail!(Unavailable::ScanLimit);
        }
        let file = file?;
        let name = file.file_name();
        let Some((name, id)) = name.to_str().and_then(|name| {
            name.strip_suffix(".md")
                .filter(|id| valid_id(id))
                .map(|id| (name, id))
        }) else {
            continue;
        };
        // Occupied or edited paths are conflicts for writes, and never list entries.
        let bytes = match read(dir, name) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => continue,
            Err(error) if error.is::<Unavailable>() => continue,
            Err(error) => return Err(error),
        };
        if let Some(entry) = Entry::parse(&bytes, id) {
            let version = digest(&bytes);
            let pinned = match pins {
                Some(pins) => pins.pinned(id, &version)?,
                None => false,
            };
            entries.push(Listed {
                id: id.into(),
                version,
                entry,
                pinned,
                done: false,
                reading_version: None,
            });
        }
    }
    entries.sort_by_cached_key(|item| {
        Reverse((
            item.pinned,
            OffsetDateTime::parse(&item.entry.saved_at, &Rfc3339).ok(),
            item.id.clone(),
        ))
    });
    Ok(entries)
}

fn listed_done(dir: &Dir, id: &str, version: &str) -> Result<bool> {
    is_done(dir, id, version).or_else(|error| {
        if error.is::<Unavailable>() {
            Ok(false)
        } else {
            Err(error)
        }
    })
}

fn listed_reading(
    dir: &Dir,
    journal: Option<&Dir>,
    id: &str,
    version: &str,
    include_reading: bool,
) -> Result<(bool, Option<String>)> {
    let baseline = listed_done(dir, id, version)?;
    if journal.is_none() && !include_reading {
        return Ok((baseline, None));
    }
    let current = reading::current(journal, id, version, baseline)?;
    Ok((current.done, include_reading.then_some(current.version)))
}

fn matches_state(done: bool, state: &str) -> bool {
    (!done || state != "open") && (done || state != "done")
}

#[cfg(test)]
mod tests;

mod search;
