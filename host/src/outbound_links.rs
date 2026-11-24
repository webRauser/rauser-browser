//! Optional capture-time enrichment. The native host checks original URLs;
//! only normalized URLs and removed parameter names reach durable storage.
use brauser_protocol::{
    OutboundLinkCoverageState, OutboundLinkFrameScope, OutboundLinkObservation,
    OutboundLinkSourceKind, OutboundLinksRecorded, PROTOCOL_VERSION, RecordOutboundLinksRequest,
    Response, VisitOutcome,
};
use serde::{Deserialize, Serialize};

use crate::capture::{CaptureOutcome, CaptureStore, canonical_url_with_provenance};
use crate::config::ConfigStore;
use crate::url_provenance::{StoredUrl, UrlProvenance};

pub(crate) const MAX_OBSERVATION_BYTES: usize = 64 * 1024;
const MAX_TARGETS: usize = 100;
// Activity sources are hour buckets. A summary's extraction may precede its
// answer/save by the entire queue/run interval, bounded by delivery age only.
const MAX_SOURCE_DISTANCE_SECS: i64 = 3600;

/// Observation UUIDs and legacy capture UUIDs occupy disjoint durable key
/// domains. Only this host-derived key reaches the shared writer/receipt;
/// public observation IDs and source IDs remain canonical UUIDs.
pub(crate) fn observation_key(canonical_uuid: &str) -> String {
    format!("links_to:{canonical_uuid}")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredObservation {
    pub observation: OutboundLinkObservation,
    pub source_artifact_id: String,
    pub source_artifact_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CheckedObservation {
    pub record: StoredObservation,
    pub provenance: UrlProvenance,
}

/// Constructible only after all untrusted fields/targets have been checked.
pub(crate) struct PreparedObservation {
    pub observation: OutboundLinkObservation,
    pub provenance: UrlProvenance,
    pub source_identity: Option<(String, String)>,
}

/// Complete validated source evidence, never a caller-supplied authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceCapture {
    pub kind: OutboundLinkSourceKind,
    pub event_id: String,
    pub occurred_at: String,
    pub url: String,
    pub artifact_id: String,
    pub artifact_type: String,
    pub fingerprint: String,
    pub stripped_params: Option<Vec<String>>,
}

fn safe_url(raw: &str, strip: &[String]) -> Result<StoredUrl, &'static str> {
    if raw.is_empty() || raw.len() > 8192 || raw.chars().any(char::is_control) {
        return Err("invalid_link_url");
    }
    let stored = canonical_url_with_provenance(raw, strip).map_err(|_| "invalid_link_url")?;
    if stored.url.len() > 8192 {
        return Err("invalid_link_url");
    }
    Ok(stored)
}

fn shape(observation: &OutboundLinkObservation, delivery: bool) -> Result<(), &'static str> {
    use crate::capture::{check_event_window, parse_event_id, parse_event_time};
    if observation.targets.len() > MAX_TARGETS
        || observation.policy_revision.is_empty()
        || observation.policy_revision.len() > 128
        || observation.coverage.anchors_inspected > 500
        || observation.targets.len() > observation.coverage.anchors_inspected as usize
        || parse_event_id(&observation.observation_id).as_deref()
            != Ok(observation.observation_id.as_str())
        || parse_event_id(&observation.source.event_id).as_deref()
            != Ok(observation.source.event_id.as_str())
    {
        return Err("invalid_link_observation");
    }
    match observation.coverage.state {
        OutboundLinkCoverageState::Complete if observation.coverage.reason.is_some() => {
            return Err("invalid_link_coverage");
        }
        OutboundLinkCoverageState::Partial | OutboundLinkCoverageState::Unavailable
            if observation.coverage.reason.is_none() =>
        {
            return Err("invalid_link_coverage");
        }
        _ => {}
    }
    if observation.coverage.state == OutboundLinkCoverageState::Unavailable
        && !observation.targets.is_empty()
    {
        return Err("invalid_link_coverage");
    }
    if observation.frame_scope == OutboundLinkFrameScope::TopDocument && observation.frame_id != 0 {
        return Err("invalid_link_frame");
    }
    let source =
        parse_event_time(&observation.source.occurred_at).map_err(|_| "invalid_link_timestamp")?;
    let at = parse_event_time(&observation.observed_at).map_err(|_| "invalid_link_timestamp")?;
    if delivery {
        check_event_window(source).map_err(|_| "invalid_link_timestamp")?;
        check_event_window(at).map_err(|_| "invalid_link_timestamp")?;
    }
    if (observation.source.kind == OutboundLinkSourceKind::Activity
        && (at < source || (at - source).whole_seconds() >= MAX_SOURCE_DISTANCE_SECS))
        || (observation.source.kind == OutboundLinkSourceKind::Summary && at > source)
    {
        return Err("link_source_time_mismatch");
    }
    Ok(())
}

pub(crate) fn prepare(
    config: &ConfigStore,
    request: &RecordOutboundLinksRequest,
) -> Result<PreparedObservation, &'static str> {
    if serde_json::to_vec(request)
        .map_err(|_| "invalid_link_observation")?
        .len()
        > MAX_OBSERVATION_BYTES
    {
        return Err("link_observation_too_large");
    }
    let observation = &request.observation;
    shape(observation, true)?;
    if observation.policy_revision != config.revision() {
        return Err("link_policy_changed");
    }
    let strip = &config.snapshot().strip_params;
    let source = safe_url(&observation.source.url, strip)?;
    let document = safe_url(&observation.document_url, strip)?;
    if observation.frame_scope == OutboundLinkFrameScope::TopDocument && source.url != document.url
    {
        return Err("invalid_link_frame");
    }
    let source_identity = if observation.source.kind == OutboundLinkSourceKind::Activity {
        if !config.snapshot().capture_enabled {
            return Err("capture_disabled");
        }
        let matched = config
            .adapter_match(&observation.source.url, None)
            .map_err(|_| "link_source_not_allowed")?;
        Some((matched.artifact_id, matched.artifact_type))
    } else {
        None
    };
    let mut prepared = observation.clone();
    prepared.source.url = source.url;
    prepared.document_url = document.url;
    prepared.targets.clear();
    let mut provenance = UrlProvenance {
        url: source.stripped_params.unwrap(),
        document: document.stripped_params,
        ..UrlProvenance::default()
    };
    for target in &observation.targets {
        if target.artifact_id.is_empty()
            || target.artifact_id.len() > 512
            || target.artifact_type.is_empty()
            || target.artifact_type.len() > 64
            || target
                .label
                .as_ref()
                .is_some_and(|label| label.chars().count() > 256)
        {
            return Err("invalid_link_target");
        }
        // All claims are checked before deduplication, including self-links.
        let stored = safe_url(&target.url, strip)?;
        let matched = config
            .adapter_match(&target.url, None)
            .map_err(|_| "link_target_not_allowed")?;
        if matched.artifact_id != target.artifact_id
            || matched.artifact_type != target.artifact_type
        {
            return Err("link_target_identity_mismatch");
        }
        let label = target
            .label
            .as_ref()
            .map(|label| crate::presentation::plain_line(label, 256))
            .filter(|label| !label.is_empty());
        if let Some(previous) = prepared
            .targets
            .iter_mut()
            .find(|previous| previous.artifact_id == matched.artifact_id)
        {
            if previous.label.is_none() {
                previous.label = label;
            }
            continue;
        }
        let mut target = target.clone();
        target.url = stored.url;
        target.label = label;
        prepared.targets.push(target);
        provenance.targets.push(stored.stripped_params.unwrap());
    }
    // Include worst-case escaped source identity and names-only provenance in
    // the stored-data bound before opening the selected home.
    let bounded = CheckedObservation {
        record: StoredObservation {
            observation: prepared.clone(),
            source_artifact_id: "\u{1}".repeat(512),
            source_artifact_type: "\u{1}".repeat(64),
        },
        provenance: provenance.clone(),
    };
    if serde_json::to_vec(&bounded)
        .map_err(|_| "invalid_link_observation")?
        .len()
        > MAX_OBSERVATION_BYTES
    {
        return Err("link_observation_too_large");
    }
    Ok(PreparedObservation {
        observation: prepared,
        provenance,
        source_identity,
    })
}

pub(crate) fn record(request: RecordOutboundLinksRequest, config: &mut ConfigStore) -> Response {
    if crate::capture::parse_event_id(&request.observation.observation_id).as_deref()
        != Ok(request.observation.observation_id.as_str())
    {
        // Refuse invalid correlation before any I/O and never reflect an
        // unbounded invalid ID into the limited native response frame.
        return crate::native::error(
            &request.request_id,
            brauser_protocol::ErrorCode::InvalidRequest,
            "observation_id must be a canonical UUID",
        );
    }
    let answer = |outcome, reason, relative_path| {
        Response::OutboundLinksRecorded(OutboundLinksRecorded {
            protocol_version: PROTOCOL_VERSION,
            request_id: request.request_id.clone(),
            observation_id: request.observation.observation_id.clone(),
            outcome,
            reason,
            relative_path,
        })
    };
    let Ok(_lock) = config.lock_current() else {
        return answer(
            VisitOutcome::Retryable,
            Some("configuration is unavailable".into()),
            None,
        );
    };
    if config.refresh().is_err()
        || config.config_issue().is_some()
        || config.adapter_issue().is_some()
    {
        return answer(
            VisitOutcome::Retryable,
            Some("configuration or adapter policy is unavailable".into()),
            None,
        );
    }
    let prepared = match prepare(config, &request) {
        Ok(value) => value,
        Err(reason) => return answer(VisitOutcome::Rejected, Some(reason.into()), None),
    };
    let Some(storage) = config.snapshot().storage.as_ref() else {
        return answer(
            VisitOutcome::Retryable,
            Some("choose a home folder before capture".into()),
            None,
        );
    };
    let store = match config
        .dir()
        .and_then(|dir| CaptureStore::open_in(storage, config.root_identity(), dir))
    {
        Ok(store) => store,
        Err(_) => {
            return answer(
                VisitOutcome::Retryable,
                Some("home folder is unavailable".into()),
                None,
            );
        }
    };
    match store.record_links(prepared) {
        CaptureOutcome::Persisted { relative_path } => answer(
            VisitOutcome::Persisted,
            None,
            Some(relative_path.to_string_lossy().into_owned()),
        ),
        CaptureOutcome::Suppressed { reason } => {
            answer(VisitOutcome::Suppressed, Some(reason), None)
        }
        CaptureOutcome::Rejected { reason } => answer(VisitOutcome::Rejected, Some(reason), None),
        CaptureOutcome::Retryable { .. } => answer(
            VisitOutcome::Retryable,
            Some("link observation could not be saved".into()),
            None,
        ),
    }
}

impl CheckedObservation {
    /// Historical validation never reclassifies URLs with today's adapters or
    /// clock. Missing/misaligned names-only evidence is corruption, not legacy.
    pub(crate) fn valid(&self) -> bool {
        let r = &self.record;
        let o = &r.observation;
        let safe = |url: &str| safe_url(url, &[]).is_ok_and(|stored| stored.url == url);
        let identity = |id: &str, ty: &str| {
            !id.is_empty() && id.len() <= 512 && !ty.is_empty() && ty.len() <= 64
        };
        if !identity(&r.source_artifact_id, &r.source_artifact_type)
            || !self.provenance.valid_links(o.targets.len())
            || !crate::url_provenance::names_absent(&o.source.url, &self.provenance.url)
            || !self
                .provenance
                .document
                .as_ref()
                .is_some_and(|names| crate::url_provenance::names_absent(&o.document_url, names))
            || !safe(&o.source.url)
            || !safe(&o.document_url)
            || serde_json::to_vec(self).map_or(true, |bytes| bytes.len() > MAX_OBSERVATION_BYTES)
        {
            return false;
        }
        // Structural/time consistency is independent of the delivery window.
        if shape(o, false).is_err()
            || (o.frame_scope == OutboundLinkFrameScope::TopDocument
                && o.source.url != o.document_url)
        {
            return false;
        }
        let mut ids = std::collections::BTreeSet::new();
        o.targets
            .iter()
            .zip(&self.provenance.targets)
            .all(|(target, names)| {
                identity(&target.artifact_id, &target.artifact_type)
                    && target.artifact_id != r.source_artifact_id
                    && ids.insert(&target.artifact_id)
                    && safe(&target.url)
                    && crate::url_provenance::names_absent(&target.url, names)
                    && target.label.as_ref().is_none_or(|label| {
                        !label.is_empty()
                            && label.chars().count() <= 256
                            && !label.chars().any(char::is_control)
                    })
            })
    }

    pub(crate) fn evidence(&self) -> Vec<(String, String, StoredUrl)> {
        let r = &self.record;
        let mut result = vec![(
            r.source_artifact_id.clone(),
            r.source_artifact_type.clone(),
            StoredUrl {
                url: r.observation.source.url.clone(),
                stripped_params: (!self.provenance.source_unknown)
                    .then(|| self.provenance.url.clone()),
            },
        )];
        result.extend(
            r.observation
                .targets
                .iter()
                .zip(&self.provenance.targets)
                .map(|(target, names)| {
                    (
                        target.artifact_id.clone(),
                        target.artifact_type.clone(),
                        StoredUrl {
                            url: target.url.clone(),
                            stripped_params: Some(names.clone()),
                        },
                    )
                }),
        );
        result
    }
}

#[cfg(test)]
mod tests;
