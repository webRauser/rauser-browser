//! The re-learn projection (brwr-6x2): a strict, cache-independent preview
//! of the app's views under an identity `Resolution`. Its rows come from a
//! log-only `LogScan` folded by the shared `Fold`, never from `index.db`,
//! and the views are built in memory with the same output the reads give.

use super::query::{MAX_CONTAINED, MAX_INCOMING_TRAILS, MAX_TYPES, WorklogRow};
use super::*;
use brauser_protocol::{LinkedFromView, OutboundLinkObservation, OutboundLinksView};

/// Strict, cache-independent preview of the same derivation the app uses.
/// Summary views retain their original checked paths and ownership keys.
#[derive(Serialize)]
pub(crate) struct RekeyProjection {
    artifacts: Vec<ArtifactView>,
    summaries: BTreeMap<String, Vec<SummaryView>>,
    edges: Vec<EdgeRow>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    outbound_links: BTreeMap<String, OutboundLinksView>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    linked_from: BTreeMap<String, LinkedFromView>,
    recent: Vec<ArtifactListItem>,
    recent_truncated: bool,
    worklog: Option<ProjectedWorklog>,
}

#[derive(Serialize)]
struct ProjectedWorklog {
    start: String,
    end: String,
    text: String,
    artifact_count: usize,
    capture_gaps: Vec<OverflowMarker>,
    capture_gaps_truncated: bool,
}

/// Every view of `derived`, folded from `scan`: each artifact's card and
/// summaries, the edges, Recent, and the worklog over the visited days.
pub(super) fn projection(
    scan: &LogScan,
    derived: Derived,
    resolution: &Resolution,
) -> Result<RekeyProjection> {
    let outbound_links = project_outbound_links(scan, &derived, resolution)?;
    let linked_from = project_backlinks(scan, &derived, resolution)?;
    let artifacts = derived
        .artifacts
        .values()
        .map(|row| artifact_view(row, &derived))
        .collect();
    let summaries = derived
        .artifacts
        .iter()
        .filter_map(|(id, row)| {
            let summaries: Vec<_> = row
                .summaries
                .iter()
                .filter_map(query::summary_view)
                .collect();
            (!summaries.is_empty()).then(|| (id.clone(), summaries))
        })
        .collect();
    let (recent, _, recent_truncated) = recent_derived(&derived, None, None, 64);
    let dates: BTreeSet<_> = derived
        .visits
        .iter()
        .filter_map(|v| parse_date(&v.local_date).ok())
        .collect();
    let worklog = match (dates.first(), dates.last()) {
        (Some(start), Some(end)) => {
            let (capture_gaps, capture_gaps_truncated) = query::gaps_in_range(
                scan.gaps
                    .iter()
                    .map(|(id, gap)| (id.clone(), gap.marker.clone())),
                *start,
                *end,
            );
            let (mut text, artifact_count) = worklog_derived(&derived, *start, *end);
            let mut groups = focus::FocusGroups::default();
            for visit in &derived.visits {
                if visit.contained || parse_date(&visit.local_date).is_err() {
                    continue;
                }
                if let Some(CachedEvent {
                    data: EventData::Activity(event),
                    ..
                }) = scan.events.get(&visit.event_id)
                {
                    groups.add(&visit.artifact_id, event);
                }
            }
            groups.append(&mut text);
            Some(ProjectedWorklog {
                start: start.to_string(),
                end: end.to_string(),
                text,
                artifact_count,
                capture_gaps,
                capture_gaps_truncated,
            })
        }
        _ => None,
    };
    Ok(RekeyProjection {
        artifacts,
        summaries,
        edges: derived.edges,
        outbound_links,
        linked_from,
        recent,
        recent_truncated,
        worklog,
    })
}

fn project_backlinks(
    scan: &LogScan,
    derived: &Derived,
    resolution: &Resolution,
) -> Result<BTreeMap<String, LinkedFromView>> {
    let mut checked = scan
        .links
        .values()
        .map(|(item, _)| item)
        .collect::<Vec<_>>();
    checked.sort_by(|a, b| {
        let a = &a.record.observation;
        let b = &b.record.observation;
        timestamp_order(&b.observed_at, &a.observed_at)
            .then_with(|| b.observation_id.cmp(&a.observation_id))
    });
    let mut targets = BTreeMap::<_, Vec<brauser_protocol::LinkedFromItemView>>::new();
    for checked in checked {
        let record = &checked.record;
        let observation = &record.observation;
        let source = resolution.canonical(&record.source_artifact_id);
        let Some((event, artifact)) = scan
            .events
            .get(&observation.source.event_id)
            .zip(derived.artifacts.get(source))
        else {
            continue;
        };
        if !source_binding(event).is_some_and(|binding| binding.matches_observation(record)) {
            continue;
        }
        for target in &observation.targets {
            let target = resolution.canonical(&target.artifact_id);
            if target == source {
                continue;
            }
            let items = targets.entry(target).or_default();
            if items.len() <= links::MAX_BACKLINKS
                && !items.iter().any(|item| item.source.artifact_id == source)
            {
                items.push(links::backlink_item(checked, source, &artifact.title));
            }
        }
    }
    targets
        .into_iter()
        .map(|(target, items)| Ok((target.to_owned(), links::bound_backlinks(items)?)))
        .collect()
}

fn project_outbound_links(
    scan: &LogScan,
    derived: &Derived,
    resolution: &Resolution,
) -> Result<BTreeMap<String, OutboundLinksView>> {
    #[derive(Default)]
    struct Latest<'a> {
        collection: Option<&'a OutboundLinkObservation>,
        snapshot: Option<&'a OutboundLinkObservation>,
    }
    let newer = |candidate: &OutboundLinkObservation, current: Option<&OutboundLinkObservation>| {
        current.is_none_or(|current| {
            timestamp_order(&candidate.observed_at, &current.observed_at)
                .then_with(|| candidate.observation_id.cmp(&current.observation_id))
                .is_gt()
        })
    };
    let mut sources = BTreeMap::<&str, Latest<'_>>::new();
    for (checked, _) in scan.links.values() {
        let source = resolution.canonical(&checked.record.source_artifact_id);
        if !derived.artifacts.contains_key(source) {
            continue;
        }
        let latest = sources.entry(source).or_default();
        let observation = &checked.record.observation;
        if newer(observation, latest.collection) {
            latest.collection = Some(observation);
        }
        if links::usable(observation) && newer(observation, latest.snapshot) {
            latest.snapshot = Some(observation);
        }
    }
    if sources.is_empty() {
        return Ok(BTreeMap::new());
    }
    let titled = derived
        .visits
        .iter()
        .filter(|visit| !visit.contained)
        .filter_map(|visit| {
            let row = derived.artifacts.get(&visit.artifact_id)?;
            (row.title == visit.title).then_some(row.artifact_id.as_str())
        })
        .collect::<BTreeSet<_>>();
    sources
        .into_iter()
        .map(|(id, latest)| {
            let collection = latest.collection.expect("each source has one collection");
            let view = links::view(
                collection,
                latest.snapshot,
                id,
                Some(resolution),
                |target| {
                    Ok(derived
                        .artifacts
                        .get(target)
                        .filter(|_| titled.contains(target))
                        .map(|row| row.title.clone()))
                },
            )?;
            Ok((id.to_owned(), view))
        })
        .collect()
}

fn incoming_trails(id: &str, derived: &Derived) -> Vec<IncomingTrailView> {
    let mut incoming = derived
        .edges
        .iter()
        .filter(|edge| {
            edge.target == id
                && edge.source != id
                && trail_transition_is_valid(&edge.kind)
                // Back/forward has no attributed same-tab source. Do not
                // turn a historical paired source into apparent provenance.
                && edge.kind != "forward_back"
        })
        .filter_map(|edge| Some((edge, derived.artifacts.get(&edge.source)?)))
        .collect::<Vec<_>>();
    incoming.sort_by(|(a, _), (b, _)| {
        b.last_seen
            .cmp(&a.last_seen)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.kind.cmp(&b.kind))
    });
    incoming
        .into_iter()
        .filter_map(|(edge, source)| {
            query::indexed_arrival(IncomingTrailView {
                source: ArtifactRefView {
                    artifact_id: source.artifact_id.clone(),
                    artifact_type: source.artifact_type.clone(),
                    title: source.title.clone(),
                    url: source.url.clone(),
                },
                transition: edge.kind.clone(),
                last_seen: edge.last_seen.clone(),
            })
        })
        .take(MAX_INCOMING_TRAILS)
        .collect()
}

fn artifact_view(row: &ArtifactRow, derived: &Derived) -> ArtifactView {
    let id = row.artifact_id.as_str();
    let linked = linked_count(&derived.edges, &derived.artifacts, id);
    // A child normally has one container; if an adapter change left more
    // than one, the most-used edge wins, then the lowest ID.
    let within = derived
        .edges
        .iter()
        .filter(|edge| edge.kind == "within" && edge.source == id && edge.target != id)
        .filter_map(|edge| Some((edge, derived.artifacts.get(&edge.target)?)))
        .max_by(|(a, _), (b, _)| a.weight.cmp(&b.weight).then(b.target.cmp(&a.target)))
        .map(|(_, container)| ArtifactRefView {
            artifact_id: container.artifact_id.clone(),
            artifact_type: container.artifact_type.clone(),
            title: container.title.clone(),
            url: container.url.clone(),
        });
    let mut contained = derived
        .edges
        .iter()
        .filter(|edge| edge.kind == "within" && edge.target == id && edge.source != id)
        .map(|edge| edge.source.as_str())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|source| derived.artifacts.get(source))
        .collect::<Vec<_>>();
    contained.sort_by(|a, b| {
        b.focused_secs
            .cmp(&a.focused_secs)
            .then_with(|| a.artifact_id.cmp(&b.artifact_id))
    });
    let contained = contained
        .into_iter()
        .take(MAX_CONTAINED)
        .map(|child| ContainedArtifactView {
            artifact_id: child.artifact_id.clone(),
            artifact_type: child.artifact_type.clone(),
            title: child.title.clone(),
            url: child.url.clone(),
            focused_seconds: saturating_u32(child.focused_secs),
        })
        .collect();
    ArtifactView {
        artifact_id: row.artifact_id.clone(),
        artifact_type: row.artifact_type.clone(),
        title: row.title.clone(),
        url: row.url.clone(),
        first_seen: row.first_seen.clone(),
        last_seen: row.last_seen.clone(),
        focused_seconds: saturating_u32(row.focused_secs),
        background_seconds: saturating_u32(row.background_secs),
        opens: saturating_u32(row.opens),
        days_opened: saturating_u32(row.days.len() as u64),
        last_mode: row.last_mode.clone(),
        why: row.why.clone(),
        linked_count: saturating_u32(linked as u64),
        within,
        contained,
        incoming_trails: incoming_trails(id, derived),
    }
}

fn linked_count(
    edges: &[EdgeRow],
    artifacts: &BTreeMap<String, ArtifactRow>,
    artifact_id: &str,
) -> usize {
    let mut linked = BTreeSet::new();
    for edge in edges {
        let other = if edge.source == artifact_id {
            Some(edge.target.as_str())
        } else if edge.target == artifact_id {
            Some(edge.source.as_str())
        } else {
            None
        };
        if let Some(other) = other
            && other != artifact_id
            && artifacts.contains_key(other)
        {
            linked.insert(other);
        }
    }
    linked.len()
}

/// Recent over derived rows: one row per artifact and local day, newest
/// day first and then by that day's measured focus.
fn recent_derived(
    derived: &Derived,
    artifact_type: Option<&str>,
    title_query: Option<&str>,
    limit: usize,
) -> (Vec<ArtifactListItem>, Vec<String>, bool) {
    let types = derived
        .artifacts
        .values()
        .map(|row| row.artifact_type.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_TYPES)
        .collect::<Vec<_>>();
    let query = title_query.map(str::trim).filter(|value| !value.is_empty());
    let query = query.map(|value| value.to_lowercase());
    let mut grouped = BTreeMap::<(String, String), ArtifactListItem>::new();
    for visit in &derived.visits {
        let Some(artifact) = derived.artifacts.get(&visit.artifact_id) else {
            continue;
        };
        if artifact_type.is_some_and(|wanted| wanted != artifact.artifact_type) {
            continue;
        }
        if query
            .as_ref()
            .is_some_and(|wanted| !artifact.title.to_lowercase().contains(wanted))
        {
            continue;
        }
        let row = grouped
            .entry((visit.local_date.clone(), visit.artifact_id.clone()))
            .or_insert_with(|| ArtifactListItem {
                local_date: visit.local_date.clone(),
                artifact_id: visit.artifact_id.clone(),
                artifact_type: artifact.artifact_type.clone(),
                title: artifact.title.clone(),
                url: artifact.url.clone(),
                focused_seconds: 0,
                background_seconds: 0,
                opens: 0,
                why: artifact.why.clone(),
                summary: None,
            });
        // Visits are in time order, so the day's latest summary that
        // renders wins.
        if let Some(view) = visit.summary.as_ref().and_then(query::summary_view) {
            row.summary = Some(view);
        }
        row.focused_seconds =
            saturating_u32(u64::from(row.focused_seconds).saturating_add(visit.focused_secs));
        row.background_seconds =
            saturating_u32(u64::from(row.background_seconds).saturating_add(visit.background_secs));
        row.opens = saturating_u32(u64::from(row.opens).saturating_add(visit.opens));
    }
    let mut items = grouped.into_values().collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .local_date
            .cmp(&left.local_date)
            .then(right.focused_seconds.cmp(&left.focused_seconds))
            .then(left.title.cmp(&right.title))
            .then(left.artifact_id.cmp(&right.artifact_id))
    });
    let truncated = items.len() > limit;
    items.truncate(limit);
    (items, types, truncated)
}

/// The worklog text and artifact count over derived rows for an inclusive
/// range of local dates, rendered by the reads' own `worklog_text`.
fn worklog_derived(derived: &Derived, start: Date, end: Date) -> (String, usize) {
    let mut rows = BTreeMap::<String, WorklogRow>::new();
    for visit in &derived.visits {
        let Ok(date) = parse_date(&visit.local_date) else {
            continue;
        };
        if date < start || date > end {
            continue;
        }
        let row = rows.entry(visit.artifact_id.clone()).or_default();
        row.focused = row.focused.saturating_add(visit.focused_secs);
        row.background = row.background.saturating_add(visit.background_secs);
        row.opens = row.opens.saturating_add(visit.opens);
        if !visit.contained {
            row.own_focused = row.own_focused.saturating_add(visit.focused_secs);
            row.own_opens = row.own_opens.saturating_add(visit.opens);
        }
        if let Some(summary) = &visit.summary
            && row.summary.as_ref().is_none_or(|current| {
                timestamp_order(&summary.occurred_at, &current.occurred_at).is_ge()
            })
        {
            row.summary = Some(summary.clone());
        }
    }
    for (id, row) in &mut rows {
        row.artifact = derived.artifacts.get(id).map(|artifact| {
            (
                artifact.artifact_type.clone(),
                artifact.title.clone(),
                artifact.why.clone(),
            )
        });
    }
    query::worklog_text(rows)
}
