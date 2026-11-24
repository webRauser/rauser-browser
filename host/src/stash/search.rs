//! Private content scan over freshly checked Stash receipts in caller order.
//! Receipt acquisition and the eventual native continuation are separate.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use anyhow::{Result, ensure};
use brauser_protocol::AnswerReadScope;

use super::{Entry, Listed, Unavailable, summary};
use crate::note::stash_search_body;
use crate::presentation::plain_line;
use crate::vault::stash_search::{MAX_READ_BYTES, Occupant};
use crate::vault::{FoundSummary, Vault};

const SNIPPET_CHARS: usize = 160;

#[derive(Clone, Copy)]
struct Limits {
    files: usize,
    bytes: u64,
    elapsed: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            files: 64,
            bytes: 2 * MAX_READ_BYTES,
            elapsed: Duration::from_millis(250),
        }
    }
}

// Inputs for the experiment. Apply summary filters only to the checked
// projection, including the note fallback, so missing or conflicting files
// cannot masquerade as known document types or reading coverage.
#[derive(Default)]
struct Filters<'a> {
    source_host: Option<&'a str>,
    document_type: Option<&'a str>,
    read_scope: Option<AnswerReadScope>,
}

#[derive(Debug, PartialEq, Eq)]
enum Source {
    Summary,
    Note,
}

#[derive(Debug, PartialEq, Eq)]
struct Hit {
    id: String,
    source: Source,
    // Literal single-line text. The eventual UI must use a text node.
    snippet: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Boundary {
    home: String,
    position: usize,
    id: String,
    version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Limit {
    Files,
    Bytes,
    Elapsed,
}

#[derive(Debug, PartialEq, Eq)]
enum Stop {
    Exhausted,
    Limited {
        reason: Limit,
        after: Option<Boundary>,
    },
}

struct Batch {
    hits: Vec<Hit>,
    stop: Stop,
}

/// `entries` must be reacquired from the checked Stash directory for this
/// home on every call. A boundary names the last completely evaluated receipt,
/// even when its batch has no matches. It is private to this experiment.
fn scan(
    vault: &Vault,
    entries: &[Listed],
    query: &str,
    filters: &Filters<'_>,
    after: Option<&Boundary>,
    limits: Limits,
) -> Result<Batch> {
    let started = Instant::now();
    ensure!(entries.len() <= super::SCAN_LIMIT, Unavailable::ScanLimit);
    ensure!(query.chars().count() <= 256, "search query is too long");
    let query = query.trim().to_lowercase();
    ensure!(!query.is_empty(), "search requires a term");
    let scope = vault.stash_search_scope()?;
    let start = match after {
        Some(after)
            if after.home == scope.home
                && entries
                    .get(after.position)
                    .is_some_and(|row| row.id == after.id && row.version == after.version) =>
        {
            after.position + 1
        }
        Some(_) => return Err(Unavailable::Changed.into()),
        None => 0,
    };
    let mut seen: HashSet<_> = entries[..start].iter().map(|row| row.id.as_str()).collect();
    let mut hits = Vec::new();
    let mut progress = start;
    let mut remaining = limits;
    let mut limit = None;
    for row in &entries[start..] {
        if started.elapsed() >= limits.elapsed {
            limit = Some(Limit::Elapsed);
            break;
        }
        if seen.insert(row.id.as_str()) && source_matches(&row.entry, filters.source_host) {
            if remaining.files < 2 {
                limit = Some(Limit::Files);
                break;
            }
            // Reserve both paths before content I/O. A partial item could
            // otherwise require a separate continuation between its files.
            let summary = scope.inspect_summary(&row.entry.key, &row.entry.url)?;
            let note = scope.inspect_note(&row.entry.key, &row.entry.url)?;
            let bytes: u64 = summary.iter().chain(&note).map(Occupant::reservation).sum();
            if bytes > remaining.bytes {
                limit = Some(Limit::Bytes);
                break;
            }
            if started.elapsed() >= limits.elapsed {
                limit = Some(Limit::Elapsed);
                break;
            }
            remaining.files -= 2;
            remaining.bytes -= bytes;
            if let Some((source, snippet)) =
                match_content(&row.entry, summary, note, &query, filters)?
            {
                hits.push(Hit {
                    id: row.id.clone(),
                    source,
                    snippet,
                });
            }
        }
        progress += 1;
    }
    let stop = match limit {
        None => Stop::Exhausted,
        Some(reason) => Stop::Limited {
            reason,
            after: progress.checked_sub(1).map(|position| Boundary {
                home: scope.home,
                position,
                id: entries[position].id.clone(),
                version: entries[position].version.clone(),
            }),
        },
    };
    Ok(Batch { hits, stop })
}

fn source_matches(entry: &Entry, host: Option<&str>) -> bool {
    host.is_none_or(|host| {
        url::Url::parse(&entry.url)
            .ok()
            .and_then(|url| {
                url.host_str()
                    .map(|actual| actual.eq_ignore_ascii_case(host))
            })
            .unwrap_or(false)
    })
}

fn match_content(
    entry: &Entry,
    summary_file: Option<Occupant<'_>>,
    note_file: Option<Occupant<'_>>,
    query: &str,
    filters: &Filters<'_>,
) -> Result<Option<(Source, String)>> {
    let (projection, description_match) = match summary_file {
        Some(file) => {
            let found = file.read_summary(&entry.key)?;
            let description_match = match &found {
                FoundSummary::Owned { bytes, .. } => {
                    summary_description(bytes).and_then(|text| find_snippet(text, query))
                }
                _ => None,
            };
            (summary(found, &entry.key), description_match)
        }
        None => (None, None),
    };
    let document_type = projection
        .as_ref()
        .and_then(|summary| summary.document_type.as_deref());
    let scope = projection.as_ref().and_then(|summary| summary.read_scope);
    if filters.document_type.is_some_and(|wanted| {
        !document_type.is_some_and(|actual| actual.eq_ignore_ascii_case(wanted))
    }) || filters
        .read_scope
        .is_some_and(|wanted| scope != Some(wanted))
    {
        return Ok(None);
    }
    if let Some(snippet) = projection
        .and_then(|summary| summary.overview)
        .and_then(|overview| find_snippet(&overview, query))
        .or(description_match)
    {
        return Ok(Some((Source::Summary, snippet)));
    }
    let Some(note_file) = note_file else {
        return Ok(None);
    };
    Ok(
        stash_search_body(&entry.key, &entry.url, &note_file.read()?)
            .and_then(|body| find_snippet(&body, query))
            .map(|snippet| (Source::Note, snippet)),
    )
}

// Only the generated description is searched in the Markdown body. The
// overview comes from the existing projection. Exclude links, headings,
// read-scope labels, incoming navigation and other generated scaffolding.
fn summary_description(bytes: &[u8]) -> Option<&str> {
    let (_, body) = std::str::from_utf8(bytes)
        .ok()?
        .strip_prefix("---\n")?
        .split_once("\n---\n")?;
    let (_, section) = body.split_once("\n## Summary\n")?;
    let (description, _) = section.split_once("\n## Assessment\n")?;
    Some(
        description
            .split_once("\n## Key points\n")
            .map_or(description, |(description, _)| description),
    )
}

fn find_snippet(text: &str, query: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = plain_line(line, usize::MAX);
        let offset = line.to_lowercase().find(query)?;
        // Lowercase can expand characters, so map the folded byte offset
        // back to a scalar position before selecting the visible excerpt.
        let mut folded_bytes = 0;
        let before = line
            .chars()
            .take_while(|ch| {
                folded_bytes += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
                folded_bytes <= offset
            })
            .count();
        let start = before.saturating_sub(36);
        Some(line.chars().skip(start).take(SNIPPET_CHARS).collect())
    })
}

mod tests;
