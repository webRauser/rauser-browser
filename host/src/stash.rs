//! Create-only Stash entries and completion markers in the selected home.
use std::{
    cmp::Reverse,
    io::{self, Write},
};

use anyhow::{Context, Result, bail};
use brauser_protocol::{ImportanceLevel, RecordKey, RecordKeyKind, StashItem, StashSummary};
use cap_std::fs::{Dir, OpenOptions};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    markdown::{inline, yaml_string},
    presentation::plain_line,
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

#[derive(Debug)]
pub(crate) enum Unavailable {
    Occupied,
    Changed,
    SummaryOccupied,
    ScanLimit,
}

impl std::fmt::Display for Unavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Occupied => "An unrelated or edited file occupies this Stash entry's name. Move it aside and try again.",
            Self::Changed => "This Stash entry changed. Refresh Stash before continuing.",
            Self::SummaryOccupied => "A file blocks this page's summary. Move it aside and try again.",
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
    let inspected = match dir.symlink_metadata(name) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if inspected.file_type().is_symlink()
        || !inspected.is_file()
        || inspected.len() > MAX_ENTRY_BYTES
    {
        return Err(Unavailable::Occupied.into());
    }
    let bytes = read_inspected_occupant(dir, name.as_ref(), &inspected)?
        .filter(|bytes| bytes.len() as u64 <= MAX_ENTRY_BYTES)
        .ok_or(Unavailable::Occupied)?;
    Ok(Some(bytes))
}

fn publish(dir: &Dir, name: &str, contents: &str) -> Result<()> {
    if contents.len() as u64 > MAX_ENTRY_BYTES {
        bail!("rendered Stash receipt exceeds its size limit");
    }
    let temporary = format!(".stash-{}.tmp", Uuid::new_v4());
    let mut file = dir.open_with(&temporary, OpenOptions::new().write(true).create_new(true))?;
    let _cleanup = TempFileCleanup::new(dir, &temporary);
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    drop(file);
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

fn summary(vault: &Vault, entry: &Entry) -> Result<Option<StashSummary>> {
    let FoundSummary::Owned {
        linked,
        summarized_at,
        bytes,
        ..
    } = vault.find_stash_summary(&entry.key, &entry.url)?
    else {
        return Ok(None);
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
    Ok(Some(StashSummary {
        path: linked,
        overview: field("overview: ", 2400),
        document_type: field("document_type: ", 64),
        category: field("category: ", 64),
        importance,
        summarized_at: summarized_at.filter(|value| valid_timestamp(value)),
    }))
}

pub(crate) fn save(
    vault: &Vault,
    key: RecordKey,
    url: String,
    title: &str,
) -> Result<(bool, bool)> {
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
        let done = is_done(&dir, &id, &digest(&bytes))?;
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
    let needs_summary = if done {
        false
    } else {
        match vault.find_stash_summary(&entry.key, &entry.url)? {
            FoundSummary::Owned { .. } => false,
            FoundSummary::Absent => true,
            FoundSummary::Unowned => return Err(Unavailable::SummaryOccupied.into()),
        }
    };
    if !already_saved {
        publish(&dir, &name, &entry.render())?;
    }
    Ok((already_saved, needs_summary))
}

pub(crate) fn complete(vault: &Vault, id: &str, version: &str) -> Result<()> {
    let dir = vault.stash_dir(false)?.ok_or(Unavailable::Changed)?;
    let bytes = read(&dir, &format!("{id}.md"))?.ok_or(Unavailable::Changed)?;
    if Entry::parse(&bytes, id).is_none() || digest(&bytes) != version {
        return Err(Unavailable::Changed.into());
    }
    let name = format!("{id}.done.md");
    let completion = done_text(id, version);
    match read(&dir, &name)? {
        Some(bytes) if bytes == completion.as_bytes() => Ok(sync_directory(&dir)?),
        Some(_) => Err(Unavailable::Occupied.into()),
        None => publish(&dir, &name, &completion),
    }
}

struct Listed {
    id: String,
    version: String,
    entry: Entry,
}

pub(crate) fn list(
    vault: &Vault,
    state: &str,
    query: &str,
    after: Option<&str>,
) -> Result<(Vec<StashItem>, Option<String>)> {
    let Some(dir) = vault.stash_dir(false)? else {
        if after.is_some() {
            return Err(Unavailable::Changed.into());
        }
        return Ok((Vec::new(), None));
    };
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
        let bytes = match read(&dir, name) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => continue,
            Err(error) if error.is::<Unavailable>() => continue,
            Err(error) => return Err(error),
        };
        if let Some(entry) = Entry::parse(&bytes, id) {
            entries.push(Listed {
                id: id.into(),
                version: digest(&bytes),
                entry,
            });
        }
    }
    entries.sort_by_cached_key(|item| {
        Reverse((
            OffsetDateTime::parse(&item.entry.saved_at, &Rfc3339).ok(),
            item.id.clone(),
        ))
    });
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
    let query = query.trim().to_lowercase();
    let mut items = Vec::new();
    for Listed { id, version, entry } in entries.into_iter().skip(start) {
        if !query.is_empty()
            && !entry.title.to_lowercase().contains(&query)
            && !entry.url.to_lowercase().contains(&query)
        {
            continue;
        }
        let done = is_done(&dir, &id, &version).or_else(|error| {
            if error.is::<Unavailable>() {
                Ok(false)
            } else {
                Err(error)
            }
        })?;
        if (done && state == "open") || (!done && state == "done") {
            continue;
        }
        if items.len() == PAGE_SIZE {
            let next = items.last().map(|item: &StashItem| item.id.clone());
            return Ok((items, next));
        }
        let summary = summary(vault, &entry)?;
        items.push(StashItem {
            id,
            version,
            title: entry.title,
            url: entry.url,
            saved_at: entry.saved_at,
            done,
            summary,
        });
    }
    Ok((items, None))
}

#[cfg(test)]
mod tests;
