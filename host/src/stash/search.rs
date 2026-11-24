//! Paginated search across checked Stash receipts, summaries and notes.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use anyhow::{Result, bail, ensure};
use brauser_protocol::{
    AnswerReadScope, StashItem, StashSearchCoverage, StashSearchLimit, StashSearchMatch,
    StashSearchMatchSource as Source, StashSearchProgress, StashSearchQuery, StashSummary,
    StashSummaryIssue,
};

use super::{
    Entry, ListPage, Listed, PAGE_SIZE, Pins, Unavailable, digest, matches_state, summary,
    summary_issue,
};
use crate::note::stash_search_body;
use crate::presentation::plain_line;
use crate::vault::stash_search::{Inspection, MAX_READ_BYTES, Occupant};
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

#[derive(Clone, Default)]
struct Filters<'a> {
    source_host: Option<&'a str>,
    document_type: Option<&'a str>,
    coverage: Option<StashSearchCoverage>,
}

struct ScanOptions<'a> {
    state: &'a str,
    query: &'a str,
    filters: Filters<'a>,
    pin_order: Option<&'a str>,
    after: Option<(&'a str, &'a str)>,
}

pub(super) struct Request<'a> {
    pub(super) state: &'a str,
    pub(super) query: &'a str,
    pub(super) after: Option<&'a str>,
    pub(super) filters: &'a StashSearchQuery,
}

struct Hit {
    position: usize,
    matched: Option<StashSearchMatch>,
    summary: Option<StashSummary>,
    issue: Option<StashSummaryIssue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Boundary {
    id: String,
    revision: String,
}

#[derive(Debug, PartialEq, Eq)]
enum Stop {
    Exhausted,
    More(Boundary),
    Limited {
        reason: StashSearchLimit,
        after: Option<Boundary>,
    },
}

struct Batch {
    hits: Vec<Hit>,
    stop: Stop,
    revision: String,
    notes_unavailable: bool,
}

pub(super) fn list(
    vault: &Vault,
    entries: Vec<Listed>,
    pins: Option<&Pins>,
    pin_order: Option<String>,
    request: Request<'_>,
) -> Result<ListPage> {
    let canonical_host = request
        .filters
        .source_host
        .as_deref()
        .map(url::Host::parse)
        .transpose()?
        .map(|host| host.to_string());
    let document_type = request
        .filters
        .document_type
        .as_deref()
        .map(|kind| kind.trim().to_lowercase());
    let options = ScanOptions {
        state: request.state,
        query: request.query,
        filters: Filters {
            source_host: canonical_host.as_deref(),
            document_type: document_type.as_deref(),
            coverage: request.filters.coverage,
        },
        pin_order: pin_order.as_deref(),
        after: request.after.zip(request.filters.revision.as_deref()),
    };
    let batch = scan(vault, &entries, &options, Limits::default())?;
    let (next, limited_by) = match batch.stop {
        Stop::Exhausted => (None, None),
        Stop::More(after) => (Some(after.id), None),
        Stop::Limited { reason, after } => (after.map(|after| after.id), Some(reason)),
    };
    let items = batch
        .hits
        .into_iter()
        .map(|hit| {
            let row = &entries[hit.position];
            let pin = pins
                .map(|pins| pins.view(&row.id, &row.version))
                .transpose()?;
            Ok(StashItem {
                id: row.id.clone(),
                version: row.version.clone(),
                title: row.entry.title.clone(),
                url: row.entry.url.clone(),
                saved_at: row.entry.saved_at.clone(),
                done: row.done,
                pin,
                search_match: hit.matched,
                summary: hit.summary,
                summary_issue: hit.issue,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ListPage {
        items,
        next,
        pin_order,
        search_progress: Some(StashSearchProgress {
            revision: batch.revision,
            limited_by,
            notes_unavailable: batch.notes_unavailable.then_some(true),
        }),
    })
}

fn scan(
    vault: &Vault,
    entries: &[Listed],
    options: &ScanOptions<'_>,
    limits: Limits,
) -> Result<Batch> {
    let scope = vault.stash_search_scope()?;
    let content_identity = scope.identity()?;
    let query = options.query.trim().to_lowercase();
    let order: Vec<_> = entries
        .iter()
        .map(|row| (&row.id, &row.version, row.done))
        .collect();
    let revision = digest(&serde_json::to_vec(&(
        "brauser.stash.search.v1",
        &content_identity,
        options.state,
        &query,
        options.filters.source_host.map(str::to_ascii_lowercase),
        options.filters.document_type.map(str::to_ascii_lowercase),
        options.filters.coverage,
        options.pin_order,
        order,
    ))?);
    let start = match options.after {
        Some((id, prior)) if prior == revision => {
            entries
                .iter()
                .position(|row| row.id == id)
                .ok_or(Unavailable::SearchChanged)?
                + 1
        }
        Some(_) => bail!(Unavailable::SearchChanged),
        None => 0,
    };
    let boundary = |position: usize| Boundary {
        id: entries[position].id.clone(),
        revision: revision.clone(),
    };
    let mut visited: HashSet<_> = entries[..start].iter().map(|row| row.id.as_str()).collect();
    let mut hits: Vec<Hit> = Vec::new();
    let mut position = start;
    let mut remaining = limits;
    let started = Instant::now();
    let mut limited_by = None;
    let mut notes_unavailable = false;
    while let Some(row) = entries.get(position) {
        if started.elapsed() >= limits.elapsed && (position > start || limits.elapsed.is_zero()) {
            limited_by = Some(StashSearchLimit::Elapsed);
            break;
        }
        if visited.insert(row.id.as_str())
            && matches_state(row.done, options.state)
            && source_matches(&row.entry, options.filters.source_host)
        {
            if remaining.files < 2 {
                limited_by = Some(StashSearchLimit::Files);
                break;
            }
            // Reserve both paths so the continuation never straddles one row.
            let summary = scope.inspect_summary(&row.entry.key, &row.entry.url);
            let note = if query.is_empty() {
                None
            } else {
                match scope.inspect_note(&row.entry.key, &row.entry.url) {
                    Ok(note) => note,
                    Err(_) => {
                        notes_unavailable = true;
                        None
                    }
                }
            };
            let bytes = summary.as_ref().map_or(0, Inspection::reservation)
                + note.as_ref().map_or(0, Occupant::reservation);
            if bytes > remaining.bytes {
                limited_by = Some(StashSearchLimit::Bytes);
                break;
            }
            if started.elapsed() >= limits.elapsed && (position > start || limits.elapsed.is_zero())
            {
                limited_by = Some(StashSearchLimit::Elapsed);
                break;
            }
            remaining.files -= 2;
            remaining.bytes -= bytes;
            if let Some(hit) = match_content(
                row,
                position,
                summary,
                note,
                &query,
                &options.filters,
                &mut notes_unavailable,
            ) {
                if hits.len() == PAGE_SIZE {
                    let last = &hits[PAGE_SIZE - 1];
                    ensure!(
                        vault.stash_search_scope()?.identity()? == content_identity,
                        Unavailable::SearchChanged
                    );
                    return Ok(Batch {
                        stop: Stop::More(boundary(last.position)),
                        hits,
                        revision,
                        notes_unavailable,
                    });
                }
                hits.push(hit);
            }
        }
        position += 1;
    }
    let stop = match limited_by {
        Some(reason) => Stop::Limited {
            reason,
            after: position.checked_sub(1).map(boundary),
        },
        None => Stop::Exhausted,
    };
    ensure!(
        vault.stash_search_scope()?.identity()? == content_identity,
        Unavailable::SearchChanged
    );
    Ok(Batch {
        hits,
        stop,
        revision,
        notes_unavailable,
    })
}

fn source_matches(entry: &Entry, host: Option<&str>) -> bool {
    host.is_none_or(|host| {
        url::Url::parse(&entry.url).ok().is_some_and(|url| {
            url.host_str()
                .is_some_and(|actual| actual.eq_ignore_ascii_case(host))
        })
    })
}

fn match_content(
    row: &Listed,
    position: usize,
    summary_file: Result<Inspection<Occupant<'_>>>,
    note_file: Option<Occupant<'_>>,
    query: &str,
    filters: &Filters<'_>,
    notes_unavailable: &mut bool,
) -> Option<Hit> {
    let entry = &row.entry;
    let found = summary_file.and_then(|file| file.read_summary(&entry.key));
    let issue = summary_issue(&found);
    let missing = matches!(found, Ok(FoundSummary::Absent));
    let description_match = match &found {
        Ok(FoundSummary::Owned { bytes, .. }) if !query.is_empty() => {
            summary_description(bytes).and_then(|text| find_snippet(text, query))
        }
        _ => None,
    };
    let projection = found.ok().and_then(|found| summary(found, &entry.key));
    let document_type = projection
        .as_ref()
        .and_then(|summary| summary.document_type.as_deref());
    let coverage = projection
        .as_ref()
        .map(|summary| match summary.read_scope {
            Some(AnswerReadScope::Whole) => StashSearchCoverage::Whole,
            Some(AnswerReadScope::Partial) => StashSearchCoverage::Partial,
            Some(AnswerReadScope::PageOnly) => StashSearchCoverage::PageOnly,
            None => StashSearchCoverage::Unknown,
        })
        .or(missing.then_some(StashSearchCoverage::Missing));
    if filters.document_type.is_some_and(|wanted| {
        !document_type.is_some_and(|actual| actual.to_lowercase() == wanted.to_lowercase())
    }) || filters
        .coverage
        .is_some_and(|wanted| coverage != Some(wanted))
    {
        return None;
    }
    let matched = if query.is_empty() {
        None
    } else if entry.title.to_lowercase().contains(query) {
        Some(StashSearchMatch {
            source: Source::Title,
            snippet: None,
        })
    } else if entry.url.to_lowercase().contains(query) {
        Some(StashSearchMatch {
            source: Source::Source,
            snippet: None,
        })
    } else if let Some(snippet) = projection
        .as_ref()
        .and_then(|summary| summary.overview.as_deref())
        .and_then(|overview| find_snippet(overview, query))
        .or(description_match)
    {
        Some(StashSearchMatch {
            source: Source::Summary,
            snippet: Some(snippet),
        })
    } else {
        let note_file = note_file?;
        let bytes = match note_file.read() {
            Ok(bytes) => bytes,
            Err(_) => {
                *notes_unavailable = true;
                return None;
            }
        };
        let snippet = stash_search_body(&entry.key, &entry.url, &bytes)
            .and_then(|body| find_snippet(&body, query))?;
        Some(StashSearchMatch {
            source: Source::Note,
            snippet: Some(snippet),
        })
    };
    Some(Hit {
        position,
        matched,
        summary: projection,
        issue,
    })
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

#[cfg(test)]
mod tests;
