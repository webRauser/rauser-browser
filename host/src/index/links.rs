//! Checked outbound observations never enter the event, visit or edge tables.
//! The log's earliest durable position wins conflicting copies of the same
//! observation, independently of watermark or delivery order.

use brauser_protocol::{
    LinkedFromItemView, LinkedFromView, OutboundLinkCoverageState, OutboundLinkItemView,
    OutboundLinkObservation, OutboundLinkSnapshotView, OutboundLinkStatusView, OutboundLinksView,
};
use rusqlite::{OptionalExtension, Transaction, params};

use super::*;
use crate::outbound_links::{CheckedObservation, observation_key};

pub(super) const MAX_BACKLINKS: usize = 8;
const MAX_BACKLINK_BYTES: usize = 64 * 1024;

impl catchup::Target {
    fn links(self) -> &'static str {
        match self {
            Self::Live => "brauser_links",
            Self::Stage => "brauser_stage_links",
        }
    }

    fn link_targets(self) -> &'static str {
        match self {
            Self::Live => "brauser_link_targets",
            Self::Stage => "brauser_stage_link_targets",
        }
    }
}

pub(super) fn initialize(tx: &Transaction<'_>, target: catchup::Target) -> Result<()> {
    let table = target.links();
    tx.execute(
        &format!(
            "CREATE TABLE IF NOT EXISTS {table}(
               observation_key TEXT PRIMARY KEY, source_id TEXT NOT NULL,
               instant INTEGER NOT NULL, usable INTEGER NOT NULL,
               log_path TEXT NOT NULL, position_key BLOB NOT NULL,
               body TEXT NOT NULL) WITHOUT ROWID"
        ),
        [],
    )?;
    for (name, columns) in [
        (
            "collection",
            "(source_id, instant DESC, observation_key DESC)",
        ),
        (
            "snapshot",
            "(source_id, instant DESC, observation_key DESC) WHERE usable = 1",
        ),
        ("log", "(log_path)"),
    ] {
        tx.execute(
            &format!("CREATE INDEX IF NOT EXISTS {table}_by_{name} ON {table}{columns}"),
            [],
        )?;
    }
    let targets = target.link_targets();
    tx.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {targets}(
           target_id TEXT NOT NULL, instant INTEGER NOT NULL,
           observation_key TEXT NOT NULL, source_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
           PRIMARY KEY(target_id, instant DESC, observation_key DESC)
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS {targets}_by_observation ON {targets}(observation_key);"
    ))?;
    if target == catchup::Target::Live {
        tx.execute(
            "CREATE INDEX IF NOT EXISTS brauser_events_by_log
               ON brauser_events(log_path, event_id) WHERE log_path IS NOT NULL",
            [],
        )?;
    }
    Ok(())
}

pub(super) fn publish_stage(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "DELETE FROM brauser_link_targets;
         DELETE FROM brauser_links;
         INSERT INTO brauser_links SELECT * FROM brauser_stage_links;
         INSERT INTO brauser_link_targets SELECT * FROM brauser_stage_link_targets;",
    )?;
    Ok(())
}

pub(super) fn has_observation_log(tx: &Transaction<'_>, path: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached("SELECT 1 FROM brauser_links WHERE log_path = ?1 LIMIT 1")?
        .exists([path])?)
}

pub(super) fn ingest(
    tx: &Transaction<'_>,
    target: catchup::Target,
    checked: &CheckedObservation,
    log_path: &str,
    position: (&Path, u64),
) -> Result<()> {
    let record = &checked.record;
    let o = &record.observation;
    let key = observation_key(&o.observation_id);
    let position_key = ord::order_key(OffsetDateTime::UNIX_EPOCH, Some(position), None, "");
    let table = target.links();
    let old: Option<(String, Vec<u8>, String)> = tx
        .prepare_cached(&format!(
            "SELECT source_id, position_key, body FROM {table} WHERE observation_key = ?1"
        ))?
        .query_row([&key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    if old
        .as_ref()
        .is_some_and(|(_, prior, _)| prior <= &position_key)
    {
        return Ok(());
    }

    let body = serde_json::to_string(checked)?;
    let mut before = BTreeMap::new();
    if target == catchup::Target::Live && old.as_ref().is_none_or(|(_, _, prior)| prior != &body) {
        for id in std::iter::once(record.source_artifact_id.as_str())
            .chain(old.as_ref().map(|(id, _, _)| id.as_str()))
        {
            if let std::collections::btree_map::Entry::Vacant(entry) = before.entry(id) {
                entry.insert(latest(tx, id)?);
            }
        }
    }
    let instant = parsed_timestamp(&o.observed_at).context("checked link timestamp")?;
    tx.prepare_cached(&format!(
        "INSERT OR REPLACE INTO {table}(observation_key, source_id, instant, usable,
          log_path, position_key, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    ))?
    .execute(params![
        key,
        record.source_artifact_id,
        instant.unix_timestamp(),
        usable(o),
        log_path,
        position_key,
        body,
    ])?;

    if old.as_ref().is_none_or(|(_, _, prior)| prior != &body) {
        let targets = target.link_targets();
        if old.is_some() {
            tx.prepare_cached(&format!("DELETE FROM {targets} WHERE observation_key = ?1"))?
                .execute([&key])?;
        }
        let mut insert = tx.prepare_cached(&format!(
            "INSERT INTO {targets}(target_id, instant, observation_key, source_id, source_event_id)
             VALUES (?1, ?2, ?3, ?4, ?5)"
        ))?;
        for target in &o.targets {
            insert.execute(params![
                target.artifact_id,
                instant.unix_timestamp(),
                key,
                record.source_artifact_id,
                o.source.event_id,
            ])?;
        }
    }

    let mut dirty = BTreeSet::new();
    for (id, previous) in before {
        if latest(tx, id)? != previous {
            dirty.insert(id.to_owned());
        }
    }
    store::mark_dirty(tx, &dirty)
}

fn latest_body(
    tx: &Transaction<'_>,
    source: &str,
    require_usable: bool,
) -> Result<Option<CheckedObservation>> {
    let sql = if require_usable {
        "SELECT body FROM brauser_links WHERE source_id = ?1 AND usable = 1
         ORDER BY instant DESC, observation_key DESC LIMIT 1"
    } else {
        "SELECT body FROM brauser_links WHERE source_id = ?1
         ORDER BY instant DESC, observation_key DESC LIMIT 1"
    };
    let body: Option<String> = tx
        .prepare_cached(sql)?
        .query_row([source], |row| row.get(0))
        .optional()?;
    body.map(|body| serde_json::from_str(&body).context("unreadable indexed link observation"))
        .transpose()
}

#[derive(PartialEq, Eq)]
pub(super) struct Latest {
    collection: CheckedObservation,
    /// Read separately only when the newest collection was unavailable.
    older_list: Option<CheckedObservation>,
}

impl Latest {
    pub(super) fn observations(
        &self,
    ) -> (&OutboundLinkObservation, Option<&OutboundLinkObservation>) {
        let latest = &self.collection.record.observation;
        let list = if usable(latest) {
            Some(latest)
        } else {
            self.older_list.as_ref().map(|row| &row.record.observation)
        };
        (latest, list)
    }
}

pub(super) fn latest(tx: &Transaction<'_>, source: &str) -> Result<Option<Latest>> {
    let Some(collection) = latest_body(tx, source, false)? else {
        return Ok(None);
    };
    let older_list = if usable(&collection.record.observation) {
        None
    } else {
        latest_body(tx, source, true)?
    };
    Ok(Some(Latest {
        collection,
        older_list,
    }))
}

pub(super) fn usable(observation: &OutboundLinkObservation) -> bool {
    observation.coverage.state != OutboundLinkCoverageState::Unavailable
}

fn status(o: &OutboundLinkObservation) -> OutboundLinkStatusView {
    OutboundLinkStatusView {
        observation_id: o.observation_id.clone(),
        observed_at: o.observed_at.clone(),
        source_kind: o.source.kind,
        source_event_id: o.source.event_id.clone(),
        frame_scope: Some(o.frame_scope),
        coverage: o.coverage.clone(),
    }
}

pub(super) fn backlink_item(
    checked: &CheckedObservation,
    source: &str,
    title: &str,
) -> LinkedFromItemView {
    let record = &checked.record;
    let o = &record.observation;
    LinkedFromItemView {
        source: ArtifactRefView {
            artifact_id: source.to_owned(),
            artifact_type: record.source_artifact_type.clone(),
            title: crate::presentation::plain_line(title, 256),
            url: o.source.url.clone(),
        },
        observed_at: o.observed_at.clone(),
        frame_scope: o.frame_scope,
        coverage: o.coverage.clone(),
    }
}

pub(super) fn bound_backlinks(mut items: Vec<LinkedFromItemView>) -> Result<LinkedFromView> {
    let truncated = items.len() > MAX_BACKLINKS;
    items.truncate(MAX_BACKLINKS);
    let mut view = LinkedFromView { items, truncated };
    while serde_json::to_vec(&view)?.len() > MAX_BACKLINK_BYTES {
        view.items.pop();
        view.truncated = true;
    }
    Ok(view)
}

pub(super) const BACKLINKS_QUERY: &str = "SELECT t.source_id, a.title, l.body
         FROM brauser_link_targets t
         JOIN brauser_links l USING(observation_key)
         JOIN brauser_events e ON e.event_id = t.source_event_id
         JOIN artifacts a ON a.artifact_id = t.source_id
         WHERE t.target_id = ?1 AND t.source_id != ?1
           AND e.log_path IS NOT NULL AND e.artifact_id = t.source_id
           AND e.kind = json_extract(l.body, '$.record.observation.source.kind')
           AND json_extract(e.body, '$.artifact_type') =
               json_extract(l.body, '$.record.source_artifact_type')
           AND json_extract(e.body, '$.occurred_at') =
               json_extract(l.body, '$.record.observation.source.occurred_at')
           AND json_extract(e.body, '$.url') =
               json_extract(l.body, '$.record.observation.source.url')
         ORDER BY t.instant DESC, t.observation_key DESC";

/// Only the target's indexed occurrences are candidates. Compare the owned
/// winning event before deduplicating, so an orphaned newer sighting cannot
/// hide a still-supported earlier one from the same source.
pub(super) fn backlinks(tx: &Transaction<'_>, target: &str) -> Result<LinkedFromView> {
    let mut statement = tx.prepare_cached(BACKLINKS_QUERY)?;
    let mut rows = statement.query([target])?;
    let mut seen = BTreeSet::new();
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        let source: String = row.get(0)?;
        if seen.insert(source.clone()) {
            let body: String = row.get(2)?;
            let checked =
                serde_json::from_str(&body).context("unreadable indexed link observation")?;
            items.push(backlink_item(&checked, &source, &row.get::<_, String>(1)?));
            if items.len() > MAX_BACKLINKS {
                break;
            }
        }
    }
    bound_backlinks(items)
}

pub(super) fn view(
    collection: &OutboundLinkObservation,
    list: Option<&OutboundLinkObservation>,
    source: &str,
    resolution: Option<&Resolution>,
    mut recorded_title: impl FnMut(&str) -> Result<Option<String>>,
) -> Result<OutboundLinksView> {
    let snapshot = if let Some(list) = list {
        let mut seen = BTreeSet::new();
        let mut targets = Vec::<OutboundLinkItemView>::with_capacity(list.targets.len());
        for target in &list.targets {
            let id = resolution.map_or(target.artifact_id.as_str(), |r| {
                r.canonical(&target.artifact_id)
            });
            if id == source {
                continue;
            }
            let label = target
                .label
                .as_deref()
                .map(|label| crate::presentation::plain_line(label, 256))
                .filter(|label| !label.is_empty());
            if !seen.insert(id) {
                // The first projected target keeps its URL. Keep the first
                // usable label too if that target had none.
                if let Some(existing) = targets
                    .iter_mut()
                    .find(|item| item.target.artifact_id == id)
                    && existing.target.label.is_none()
                {
                    existing.target.label = label;
                }
                continue;
            }
            let mut target = target.clone();
            target.artifact_id = id.to_owned();
            target.label = label;
            targets.push(OutboundLinkItemView {
                target,
                recorded_title: recorded_title(id)?
                    .map(|title| crate::presentation::plain_line(&title, 256))
                    .filter(|title| !title.is_empty() && title != "Untitled"),
            });
        }
        Some(OutboundLinkSnapshotView {
            status: status(list),
            targets,
        })
    } else {
        None
    };
    Ok(OutboundLinksView {
        collection: status(collection),
        snapshot,
    })
}

pub(super) fn detail(tx: &Transaction<'_>, source: &str) -> Result<Option<OutboundLinksView>> {
    let Some(latest) = latest(tx, source)? else {
        return Ok(None);
    };
    let (collection, list) = latest.observations();
    // A roll-up can supply an artifact name even when its own visits did
    // not record that title. Match only titles from direct captured visits.
    let mut title = tx.prepare_cached(
        "SELECT a.title FROM artifacts a WHERE a.artifact_id = ?1
           AND EXISTS(SELECT 1 FROM visits v
                      WHERE v.artifact_id = a.artifact_id AND v.title = a.title)",
    )?;
    Ok(Some(view(collection, list, source, None, |id| {
        Ok(title.query_row([id], |row| row.get(0)).optional()?)
    })?))
}
