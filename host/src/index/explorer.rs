//! Read-only, unique-artifact browsing over the same committed snapshot as Recent.
//! Summary metadata comes from the durable log projection, never agent runs or files.
use super::*;
use brauser_protocol::{
    ExplorerArtifact, ExplorerConnection, ExplorerConnectionBasis, ExplorerConnectionDirection,
    ExplorerFacet, ExplorerFacets, ExplorerLabelFacet, ExplorerReadingFilter, RecentPageInfo,
    RecentPageRequest,
};
use rusqlite::Transaction;

pub(crate) const MAX_ITEMS: usize = 8;
const MAX_FACETS: usize = 64;

pub(crate) struct Filters<'a> {
    pub query: Option<&'a str>,
    pub source: Option<&'a str>,
    pub artifact_type: Option<&'a str>,
    pub category: Option<&'a str>,
    pub document_type: Option<&'a str>,
    pub reading: Option<ExplorerReadingFilter>,
    pub limit: usize,
}

pub(crate) struct Page {
    pub items: Vec<ExplorerArtifact>,
    pub facets: ExplorerFacets,
    pub total: u32,
    pub library_total: u32,
    pub page: RecentPageInfo,
}

pub(crate) struct ArtifactContext {
    pub item: Option<ExplorerArtifact>,
    pub connections: Vec<ExplorerConnection>,
    pub truncated: bool,
}

/// One ordered projection pass, keeping only the latest renderable summary per
/// canonical indexed ID. order_key is chronological, with durable log tie order;
/// the event body may retain a pre-alias ID, so use the indexed column as the key.
fn summaries(tx: &Transaction<'_>) -> Result<BTreeMap<String, SummaryView>> {
    let mut statement = tx.prepare_cached(
        "SELECT artifact_id, body FROM brauser_events WHERE kind = 'summary' ORDER BY order_key",
    )?;
    let mut rows = statement.query([])?;
    let mut latest = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let body: String = row.get(1)?;
        let event: CachedEvent = serde_json::from_str(&body)
            .context("artifact history is unavailable: unreadable indexed event")?;
        if let EventData::Summary(event) = event.data
            && let Some(view) = query::summary_view(&event)
        {
            latest.insert(row.get(0)?, view);
        }
    }
    // Only emitted latest metadata needs the wire bound. A superseded older
    // oversized answer must not make a later valid saved summary unavailable.
    for view in latest.values() {
        // The cache may contain direct deliveries predating a wire reader.
        // Metadata identities/labels are never cut into different values.
        anyhow::ensure!(
            !view.document_type.trim().is_empty()
                && view.document_type.chars().count() <= 64
                && !view.category.trim().is_empty()
                && view.category.chars().count() <= 64
                && crate::summary::check_summary_path(&view.summary_path).is_ok()
                && view
                    .overview
                    .as_ref()
                    .is_none_or(|s| !s.is_empty() && s.chars().count() <= 300),
            "artifact history is unavailable: invalid Explorer summary metadata"
        );
    }
    Ok(latest)
}

fn scan(
    tx: &Transaction<'_>,
    latest: &BTreeMap<String, SummaryView>,
    mut visit: impl FnMut(ExplorerArtifact) -> Result<()>,
) -> Result<()> {
    let mut statement = tx.prepare_cached(
        "SELECT artifact_id, artifact_type, title, url, site, first_seen, last_seen,
                focused_secs, opens, why FROM artifacts
         ORDER BY last_seen DESC, title, artifact_id",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let artifact_id: String = row.get(0)?;
        let artifact_type: String = row.get(1)?;
        let url: String = row.get(3)?;
        let first_seen = row.get::<_, Option<String>>(5)?.unwrap_or_default();
        let last_seen = row.get::<_, Option<String>>(6)?.unwrap_or_default();
        let valid_date =
            |value: &str| value.is_empty() || value.len() == 10 && parse_date(value).is_ok();
        anyhow::ensure!(
            !artifact_id.is_empty()
                && artifact_id.len() <= 512
                && !artifact_type.is_empty()
                && artifact_type.len() <= 64
                && url.len() <= 8192
                && Url::parse(&url).is_ok_and(|url| {
                    matches!(url.scheme(), "http" | "https")
                        && url.username().is_empty()
                        && url.password().is_none()
                })
                && valid_date(&first_seen)
                && valid_date(&last_seen),
            "artifact history is unavailable: invalid Explorer artifact identity"
        );
        let source: String = row.get(4)?;
        let title: String = row.get(2)?;
        let why: Option<String> = row.get(9)?;
        visit(ExplorerArtifact {
            summary: latest.get(&artifact_id).cloned(),
            artifact_id,
            artifact_type,
            title: crate::presentation::plain_line(&title, 2048),
            url,
            // A malformed historical hostname must not become a cut hostname
            // that points at something else. Its source facet stays unknown.
            source: if source.len() <= 253 {
                source
            } else {
                String::new()
            },
            first_seen,
            last_seen,
            focused_seconds: saturating_u32(u64::try_from(row.get::<_, i64>(7)?).unwrap_or(0)),
            opens: saturating_u32(u64::try_from(row.get::<_, i64>(8)?).unwrap_or(0)),
            why: why.map(|text| crate::presentation::plain_line(&text, 500)),
        })?;
    }
    Ok(())
}

fn normalized(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn matches(item: &ExplorerArtifact, filters: &Filters<'_>, text: Option<&str>) -> bool {
    let summary = item.summary.as_ref();
    filters.source.is_none_or(|source| item.source == source)
        && filters
            .artifact_type
            .is_none_or(|kind| item.artifact_type == kind)
        && filters
            .category
            .is_none_or(|category| summary.is_some_and(|s| s.category == category))
        && filters
            .document_type
            .is_none_or(|kind| summary.is_some_and(|s| s.document_type == kind))
        && filters.reading.is_none_or(|reading| match reading {
            ExplorerReadingFilter::None => summary.is_none(),
            ExplorerReadingFilter::Unknown => summary.is_some_and(|s| s.read_scope.is_none()),
            ExplorerReadingFilter::Whole => summary
                .is_some_and(|s| s.read_scope == Some(brauser_protocol::AnswerReadScope::Whole)),
            ExplorerReadingFilter::Limited => summary.is_some_and(|s| {
                matches!(
                    s.read_scope,
                    Some(
                        brauser_protocol::AnswerReadScope::Partial
                            | brauser_protocol::AnswerReadScope::PageOnly
                    )
                )
            }),
        })
        && text.is_none_or(|text| {
            let fields = [
                Some(item.title.as_str()),
                Some(item.source.as_str()),
                item.why.as_deref(),
                summary.and_then(|s| s.overview.as_deref()),
            ]
            .into_iter()
            .flatten()
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
            text.split_whitespace()
                .all(|token| fields.iter().any(|field| field.contains(token)))
        })
}

#[derive(Default)]
struct Facets {
    sources: BTreeMap<String, u32>,
    artifact_types: BTreeMap<String, u32>,
    categories: BTreeMap<String, u32>,
    document_types: BTreeMap<String, u32>,
}

fn increment(count: &mut u32) -> Result<()> {
    *count = count
        .checked_add(1)
        .context("artifact count exceeds paging range")?;
    Ok(())
}

impl Facets {
    fn add(&mut self, item: &ExplorerArtifact) -> Result<()> {
        for (counts, value) in [
            (&mut self.sources, item.source.as_str()),
            (&mut self.artifact_types, item.artifact_type.as_str()),
            (
                &mut self.categories,
                item.summary.as_ref().map_or("", |s| s.category.as_str()),
            ),
            (
                &mut self.document_types,
                item.summary
                    .as_ref()
                    .map_or("", |s| s.document_type.as_str()),
            ),
        ] {
            if !value.is_empty() {
                increment(counts.entry(value.into()).or_default())?;
            }
        }
        Ok(())
    }

    fn finish(self) -> ExplorerFacets {
        let truncated = [
            &self.sources,
            &self.artifact_types,
            &self.categories,
            &self.document_types,
        ]
        .iter()
        .any(|values| values.len() > MAX_FACETS);
        let values = |counts: BTreeMap<String, u32>| {
            counts
                .into_iter()
                .take(MAX_FACETS)
                .map(|(value, count)| ExplorerLabelFacet { value, count })
                .collect()
        };
        ExplorerFacets {
            sources: self
                .sources
                .into_iter()
                .take(MAX_FACETS)
                .map(|(value, count)| ExplorerFacet { value, count })
                .collect(),
            artifact_types: values(self.artifact_types),
            categories: values(self.categories),
            document_types: values(self.document_types),
            truncated,
        }
    }
}

pub(super) fn page(
    tx: &Transaction<'_>,
    scope: &[u8],
    filters: Filters<'_>,
    request: &RecentPageRequest,
) -> Result<Page> {
    anyhow::ensure!(valid_recent_page_request(request), StaleRecentPage);
    let limit = filters.limit.clamp(1, MAX_ITEMS);
    let text = normalized(filters.query).map(str::to_lowercase);
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&(
        "explorer-page-v1",
        scope,
        &text,
        filters.source,
        filters.artifact_type,
        filters.category,
        filters.document_type,
        filters.reading,
        limit,
    ))?);
    let latest = summaries(tx)?;
    let mut facets = Facets::default();
    let mut items = Vec::new();
    let mut total = 0u32;
    let mut library_total = 0u32;
    scan(tx, &latest, |item| {
        increment(&mut library_total)?;
        facets.add(&item)?;
        if matches(&item, &filters, text.as_deref()) {
            let bytes = serde_json::to_vec(&item)?;
            digest.update((bytes.len() as u64).to_be_bytes());
            digest.update(bytes);
            if total >= request.offset && items.len() < limit {
                items.push(item);
            }
            increment(&mut total)?;
        }
        Ok(())
    })?;
    let facets = facets.finish();
    digest.update(serde_json::to_vec(&(&facets, total, library_total))?);
    let snapshot = hex::encode(digest.finalize());
    anyhow::ensure!(
        request.offset <= total
            && request
                .snapshot
                .as_ref()
                .is_none_or(|expected| expected == &snapshot),
        StaleRecentPage
    );
    let end = request
        .offset
        .checked_add(u32::try_from(items.len())?)
        .context("Explorer offset overflow")?;
    Ok(Page {
        items,
        facets,
        total,
        library_total,
        page: RecentPageInfo {
            snapshot,
            offset: request.offset,
            next_offset: (end < total).then_some(end),
        },
    })
}

pub(super) fn context(tx: &Transaction<'_>, artifact_id: &str) -> Result<ArtifactContext> {
    let latest = summaries(tx)?;
    let mut item = None;
    // Only indexed, canonical rows can be selected; the ID is never a path.
    scan(tx, &latest, |candidate| {
        if candidate.artifact_id == artifact_id {
            item = Some(candidate);
        }
        Ok(())
    })?;
    let Some(item) = item else {
        return Ok(ArtifactContext {
            item: None,
            connections: vec![],
            truncated: false,
        });
    };
    // A neighbor can have several recorded signals. Prefer containment, then a
    // title mention, then navigation; ties use newest date and stable IDs/kinds.
    let mut edges = tx.prepare_cached(
        "SELECT source_artifact_id, target_artifact_id, kind, last_seen FROM edges
         WHERE (source_artifact_id = ?1 OR target_artifact_id = ?1)
           AND source_artifact_id != target_artifact_id
         ORDER BY CASE kind WHEN 'within' THEN 0 WHEN 'mentions' THEN 1 ELSE 2 END,
                  last_seen DESC, source_artifact_id, target_artifact_id, kind",
    )?;
    let mut rows = edges.query([artifact_id])?;
    let mut evidence = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let source: String = row.get(0)?;
        let target: String = row.get(1)?;
        let kind: String = row.get(2)?;
        let (basis, rank, transition) = match kind.as_str() {
            "within" => (ExplorerConnectionBasis::Container, 0u8, None),
            "mentions" => (ExplorerConnectionBasis::TitleMention, 1, None),
            kind if kind != "forward_back" && trail_transition_is_valid(kind) => {
                (ExplorerConnectionBasis::Navigation, 2, Some(kind.into()))
            }
            _ => continue,
        };
        let direction = if source == artifact_id {
            ExplorerConnectionDirection::Outgoing
        } else {
            ExplorerConnectionDirection::Incoming
        };
        let neighbor = if source == artifact_id {
            target
        } else {
            source
        };
        let last_seen: String = row.get(3)?;
        anyhow::ensure!(
            last_seen.len() == 10 && parse_date(&last_seen).is_ok(),
            "artifact history is unavailable: invalid Explorer connection date"
        );
        evidence
            .entry(neighbor)
            .or_insert((basis, direction, transition, last_seen, rank));
    }
    // Retain at most cap+1 neighbors, so the cap is never mistaken for complete coverage.
    let mut connections = Vec::<(u8, ExplorerConnection)>::new();
    let category = item.summary.as_ref().map(|s| s.category.as_str());
    scan(tx, &latest, |candidate| {
        if candidate.artifact_id == artifact_id {
            return Ok(());
        }
        let connection = if let Some((basis, direction, transition, last_seen, rank)) =
            evidence.remove(&candidate.artifact_id)
        {
            Some((
                rank,
                ExplorerConnection {
                    artifact: candidate,
                    basis,
                    direction,
                    transition,
                    last_seen: Some(last_seen),
                },
            ))
        } else if category.is_some_and(|category| {
            candidate
                .summary
                .as_ref()
                .is_some_and(|s| s.category == category)
        }) {
            Some((
                3,
                ExplorerConnection {
                    artifact: candidate,
                    basis: ExplorerConnectionBasis::SameCategory,
                    direction: ExplorerConnectionDirection::Associated,
                    transition: None,
                    last_seen: None,
                },
            ))
        } else {
            None
        };
        if let Some(connection) = connection {
            connections.push(connection);
            connections.sort_by(|(rank_a, a), (rank_b, b)| {
                rank_a
                    .cmp(rank_b)
                    .then_with(|| b.last_seen.cmp(&a.last_seen))
                    .then_with(|| b.artifact.last_seen.cmp(&a.artifact.last_seen))
                    .then_with(|| a.artifact.title.cmp(&b.artifact.title))
                    .then_with(|| a.artifact.artifact_id.cmp(&b.artifact.artifact_id))
            });
            connections.truncate(MAX_ITEMS + 1);
        }
        Ok(())
    })?;
    let truncated = connections.len() > MAX_ITEMS;
    connections.truncate(MAX_ITEMS);
    Ok(ArtifactContext {
        item: Some(item),
        connections: connections.into_iter().map(|(_, c)| c).collect(),
        truncated,
    })
}
