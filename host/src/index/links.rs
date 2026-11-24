//! Checked outbound observations never enter the event, visit or edge tables.
//! The log's earliest durable position wins conflicting copies of the same
//! observation, independently of watermark or delivery order.

use brauser_protocol::{
    OutboundLinkCoverageState, OutboundLinkItemView, OutboundLinkObservation,
    OutboundLinkSnapshotView, OutboundLinkStatusView, OutboundLinksView,
};
use rusqlite::{OptionalExtension, Transaction, params};

use super::*;
use crate::outbound_links::{CheckedObservation, observation_key};

impl catchup::Target {
    fn links(self) -> &'static str {
        match self {
            Self::Live => "brauser_links",
            Self::Stage => "brauser_stage_links",
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
    Ok(())
}

pub(super) fn has_log(tx: &Transaction<'_>, target: catchup::Target, path: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached(&format!(
            "SELECT 1 FROM {} WHERE log_path = ?1 LIMIT 1",
            target.links()
        ))?
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
        coverage: o.coverage.clone(),
    }
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
