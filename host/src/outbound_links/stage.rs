//! Private checked link stages. Slot names, capabilities, and source bindings
//! are created by the host. No slot can create or repair its source record.

use std::io::{self, Read, Write};
use std::path::Path;

use anyhow::{Result, bail, ensure};
use brauser_protocol::{
    DrainOutboundLinksRequest, ErrorCode, OutboundActivitySource, OutboundLinkDraft,
    OutboundLinkFrameScope, OutboundLinkObservation, OutboundLinkSource, OutboundLinksDrained,
    OutboundLinksRecorded, OutboundLinksStaged, PROTOCOL_VERSION, PublishOutboundLinksRequest,
    StageOutboundLinksRequest,
};
use cap_std::fs::{Dir, OpenOptions};
use time::OffsetDateTime;
use uuid::Uuid;

use super::*;
use crate::vault::open_selected_root;

const STAGES: usize = 128;
const PROBES: usize = 8;
const MAX_SLOT_BYTES: usize = 68 * 1024;
const MAX_AGE: i64 = 30 * 24 * 60 * 60;
const ACTIVITY_AGE: i64 = 2 * 24 * 60 * 60;
const REPLAY_WINDOW: i64 = 2 * 60 * 60;
const UNBOUND_SUMMARY_WINDOW: i64 = 20 * 60;
const SUMMARY_DRAIN_LIMIT: usize = 4;
#[cfg(unix)]
pub(crate) const RUN_SIDECAR: &str = "outbound-links-stage.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stage {
    token: String,
    created: i64,
    root: String,
    checked: CheckedSnapshot,
    summary_key: Option<brauser_protocol::RecordKey>,
    run: Option<String>,
    summary_at: Option<String>,
    started: bool,
    frozen: Option<FrozenPublication>,
    published: Option<i64>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FrozenPublication {
    source_fingerprint: String,
    observation_digest: String,
}

impl Stage {
    fn id(&self) -> &str {
        &self.checked.draft.observation_id
    }

    fn current(&self, config: &ConfigStore, now: i64) -> bool {
        self.within_age(now) && self.policy_matches(config)
    }

    fn is_activity(&self) -> bool {
        self.checked.draft.activity_source.is_some()
    }

    // The run ID and canonical source URL are already pinned in the stage.
    // Keep only the actual summary stamp when the finisher arms delivery.
    fn summary_source(&self) -> Option<OutboundLinkSource> {
        Some(OutboundLinkSource {
            kind: OutboundLinkSourceKind::Summary,
            event_id: self.run.clone()?,
            occurred_at: self.summary_at.clone()?,
            url: self.checked.draft.source_url.clone(),
        })
    }

    fn within_age(&self, now: i64) -> bool {
        let limit = if self.is_activity() {
            ACTIVITY_AGE
        } else if self.run.is_none() {
            UNBOUND_SUMMARY_WINDOW
        } else {
            MAX_AGE
        };
        self.created <= now && now.saturating_sub(self.created) <= limit
    }

    fn policy_matches(&self, config: &ConfigStore) -> bool {
        Some(self.root.as_str()) == config.root_identity()
            && self.checked.draft.policy_revision == config.revision()
    }
}

/// The optional source is present only for activity. An unbound summary on
/// disk has neither an event UUID nor a fabricated summary timestamp.
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CheckedSnapshot {
    draft: OutboundLinkDraft,
    provenance: UrlProvenance,
    source_identity: Option<(String, String)>,
    normalized_digest: String,
}

impl CheckedSnapshot {
    fn from_prepared(prepared: PreparedObservation) -> Self {
        let o = prepared.observation;
        Self {
            draft: OutboundLinkDraft {
                observation_id: o.observation_id,
                source_url: o.source.url,
                activity_source: (o.source.kind == OutboundLinkSourceKind::Activity).then_some(
                    OutboundActivitySource {
                        event_id: o.source.event_id,
                        occurred_at: o.source.occurred_at,
                    },
                ),
                observed_at: o.observed_at,
                document_url: o.document_url,
                frame_scope: o.frame_scope,
                frame_id: o.frame_id,
                coverage: o.coverage,
                policy_revision: o.policy_revision,
                targets: o.targets,
            },
            provenance: prepared.provenance,
            source_identity: prepared.source_identity,
            normalized_digest: prepared
                .normalized_digest
                .expect("staging checks full normalized evidence"),
        }
    }

    fn for_publication(&self, source: Option<&OutboundLinkSource>) -> PreparedObservation {
        PreparedObservation {
            observation: observation(&self.draft, source),
            provenance: self.provenance.clone(),
            source_identity: self.source_identity.clone(),
            normalized_digest: None,
        }
    }
}

fn observation(
    draft: &OutboundLinkDraft,
    summary_source: Option<&OutboundLinkSource>,
) -> OutboundLinkObservation {
    let source = match draft.activity_source.as_ref() {
        Some(activity) => OutboundLinkSource {
            kind: OutboundLinkSourceKind::Activity,
            event_id: activity.event_id.clone(),
            occurred_at: activity.occurred_at.clone(),
            url: draft.source_url.clone(),
        },
        // The temporary shape is used only by admission, never for publication
        // or retention. The publisher requires a separate durable summary.
        None => summary_source
            .cloned()
            .unwrap_or_else(|| OutboundLinkSource {
                kind: OutboundLinkSourceKind::Summary,
                event_id: draft.observation_id.clone(),
                occurred_at: draft.observed_at.clone(),
                url: draft.source_url.clone(),
            }),
    };
    OutboundLinkObservation {
        observation_id: draft.observation_id.clone(),
        source,
        observed_at: draft.observed_at.clone(),
        document_url: draft.document_url.clone(),
        frame_scope: draft.frame_scope,
        frame_id: draft.frame_id,
        policy_revision: draft.policy_revision.clone(),
        coverage: draft.coverage.clone(),
        targets: draft.targets.clone(),
    }
}

struct Stages(Dir);

impl Stages {
    fn open(config: &ConfigStore, create: bool) -> Result<Self> {
        let support = Dir::open_ambient_dir(config.dir()?, cap_std::ambient_authority())?;
        let name = "outbound-link-stages-v1";
        if create {
            #[cfg(unix)]
            let builder = {
                use cap_std::fs::DirBuilderExt;
                let mut builder = cap_std::fs::DirBuilder::new();
                builder.mode(0o700);
                builder
            };
            #[cfg(not(unix))]
            let builder = cap_std::fs::DirBuilder::new();
            match support.create_dir_with(name, &builder) {
                Ok(()) => {
                    #[cfg(unix)]
                    support.open(".")?.into_std().sync_all()?;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        let metadata = support.symlink_metadata(name)?;
        ensure!(metadata.is_dir(), "invalid link stage directory");
        let dir = support.open_dir(name)?;
        #[cfg(unix)]
        {
            use cap_std::fs::MetadataExt;
            let opened = dir.dir_metadata()?;
            ensure!(
                (opened.dev(), opened.ino()) == (metadata.dev(), metadata.ino())
                    && opened.uid() == rustix::process::getuid().as_raw()
                    && opened.mode() & 0o077 == 0,
                "invalid link stage directory"
            );
        }
        Ok(Self(dir))
    }

    fn load(&self, slot: usize) -> Result<Option<Stage>> {
        let Some(bytes) = read(&self.0, &slot_name(slot), MAX_SLOT_BYTES)? else {
            return Ok(None);
        };
        let stage: Stage = serde_json::from_slice(&bytes)?;
        ensure!(
            token_slot(&stage.token) == Some(slot)
                && canonical_uuid(stage.id()).is_some()
                && stage
                    .checked
                    .provenance
                    .valid_links(stage.checked.draft.targets.len()),
            "invalid retained link stage"
        );
        Ok(Some(stage))
    }

    fn lookup(&self, token: &str) -> Result<(usize, Stage)> {
        let slot = token_slot(token).ok_or_else(|| anyhow::anyhow!("invalid link stage token"))?;
        let stage = self
            .load(slot)?
            .filter(|stage| stage.token == token)
            .ok_or_else(|| anyhow::anyhow!("link delivery gap"))?;
        Ok((slot, stage))
    }

    fn save(&self, slot: usize, stage: &Stage) -> Result<()> {
        let bytes = serde_json::to_vec(stage)?;
        ensure!(bytes.len() <= MAX_SLOT_BYTES, "link stage is too large");
        let temporary = format!("{slot:03}.tmp");
        match self.0.remove_file(&temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = self.0.open_with(&temporary, &options)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        crate::fsutil::rename_or_copy_in_dir(
            &self.0,
            Path::new(&temporary),
            &self.0,
            Path::new(&slot_name(slot)),
        )?;
        #[cfg(unix)]
        self.0.open(".")?.into_std().sync_all()?;
        Ok(())
    }
}

fn slot_name(slot: usize) -> String {
    format!("{slot:03}.json")
}

fn canonical_uuid(value: &str) -> Option<Uuid> {
    let id = Uuid::try_parse(value).ok()?;
    (id.hyphenated().to_string() == value).then_some(id)
}

fn token_slot(token: &str) -> Option<usize> {
    let (prefix, id) = token.split_once(':')?;
    let slot: usize = prefix.parse().ok()?;
    (slot < STAGES && prefix == format!("{slot:03}") && canonical_uuid(id).is_some())
        .then_some(slot)
}

fn read(dir: &Dir, name: &str, limit: usize) -> Result<Option<Vec<u8>>> {
    let metadata = match dir.symlink_metadata(name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        metadata.is_file() && metadata.len() <= limit as u64,
        "invalid link stage file"
    );
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        use rustix::fs::OFlags;
        options.custom_flags((OFlags::NOFOLLOW | OFlags::NONBLOCK).bits() as i32);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(OPEN_REPARSE_POINT);
    }
    let file = dir.open_with(name, &options)?;
    let opened = file.metadata()?;
    ensure!(
        opened.is_file() && opened.len() == metadata.len(),
        "link stage file changed"
    );
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        ensure!(
            opened.file_attributes() & REPARSE_POINT == 0,
            "invalid link stage file"
        );
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        ensure!(
            (opened.dev(), opened.ino()) == (metadata.dev(), metadata.ino())
                && opened.uid() == rustix::process::getuid().as_raw()
                && opened.mode() & 0o077 == 0,
            "invalid link stage file"
        );
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == opened.len(),
        "link stage file changed"
    );
    Ok(Some(bytes))
}

fn refresh(config: &mut ConfigStore) -> Result<()> {
    config.refresh()?;
    ensure!(
        config.config_issue().is_none() && config.adapter_issue().is_none(),
        "link policy unavailable"
    );
    Ok(())
}

fn capture_store(config: &ConfigStore) -> Result<CaptureStore> {
    let storage = config
        .snapshot()
        .storage
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("home unavailable"))?;
    let identity = config
        .root_identity()
        .ok_or_else(|| anyhow::anyhow!("home unavailable"))?;
    CaptureStore::open_in(storage, Some(identity), config.dir()?)
}

pub(crate) fn issue(request: StageOutboundLinksRequest, config: &mut ConfigStore) -> Response {
    let draft = request.draft;
    let Some(uuid) = canonical_uuid(&draft.observation_id) else {
        return crate::native::error(
            &request.request_id,
            ErrorCode::InvalidRequest,
            "invalid link observation ID",
        );
    };
    let outcome = (|| -> Result<String> {
        let _lock = config.lock_current()?;
        refresh(config)?;
        ensure!(
            draft.activity_source.is_some()
                == (draft.frame_scope == OutboundLinkFrameScope::TopDocument),
            "invalid link stage frame"
        );
        let checked = CheckedSnapshot::from_prepared(
            super::prepare_observation(config, &observation(&draft, None), true)
                .map_err(anyhow::Error::msg)?,
        );
        let summary_key = if draft.activity_source.is_none() {
            Some(
                crate::native::resolve_record_key(config, &draft.source_url)
                    .map_err(|_| anyhow::anyhow!("summary source identity unavailable"))?,
            )
        } else {
            None
        };
        let root = config
            .root_identity()
            .ok_or_else(|| anyhow::anyhow!("home unavailable"))?;
        let storage = config
            .snapshot()
            .storage
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("home unavailable"))?;
        open_selected_root(Path::new(&storage.root), Some(root))?;
        let stages = Stages::open(config, true)?;
        let at = OffsetDateTime::now_utc().unix_timestamp();
        let first = (uuid.as_u128() % STAGES as u128) as usize;
        let mut vacant = None;
        for offset in 0..PROBES {
            let slot = (first + offset) % STAGES;
            match stages.load(slot)? {
                Some(prior) if prior.id() == draft.observation_id && prior.current(config, at) => {
                    ensure!(
                        prior.checked == checked && prior.summary_key == summary_key,
                        "link stage conflict"
                    );
                    return Ok(prior.token);
                }
                Some(prior)
                    if prior.current(config, at)
                        && prior.published.is_none_or(|published| {
                            at.saturating_sub(published) < REPLAY_WINDOW
                        }) => {}
                _ => {
                    vacant.get_or_insert(slot);
                }
            }
        }
        let Some(slot) = vacant else {
            bail!("link stage capacity exhausted");
        };
        let token = format!("{slot:03}:{}", Uuid::new_v4());
        stages.save(
            slot,
            &Stage {
                token: token.clone(),
                created: at,
                root: root.into(),
                checked,
                summary_key,
                run: None,
                summary_at: None,
                started: false,
                frozen: None,
                published: None,
            },
        )?;
        Ok(token)
    })();
    Response::OutboundLinksStaged(OutboundLinksStaged {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id,
        observation_id: draft.observation_id,
        reason: outcome.as_ref().err().map(|_| "delivery_gap".into()),
        stage_token: outcome.ok(),
    })
}

fn accepted(outcome: &CaptureOutcome) -> bool {
    match outcome {
        CaptureOutcome::Persisted { .. } => true,
        CaptureOutcome::Suppressed { reason } => reason == "duplicate_event",
        _ => false,
    }
}

pub(crate) fn publish(request: PublishOutboundLinksRequest, config: &mut ConfigStore) -> Response {
    if canonical_uuid(&request.observation_id).is_none()
        || token_slot(&request.stage_token).is_none()
    {
        return crate::native::error(
            &request.request_id,
            ErrorCode::InvalidRequest,
            "invalid link stage reference",
        );
    }
    let attempt = || -> Result<CaptureOutcome> {
        let _lock = config.lock_current()?;
        refresh(config)?;
        let Ok(stages) = Stages::open(config, false) else {
            return Ok(reject("delivery_gap"));
        };
        let Ok((slot, mut stage)) = stages.lookup(&request.stage_token) else {
            return Ok(reject("delivery_gap"));
        };
        if !stage.policy_matches(config) {
            return Ok(reject("link_policy_changed"));
        }
        if !stage.within_age(OffsetDateTime::now_utc().unix_timestamp()) {
            return Ok(reject("delivery_gap"));
        }
        if stage.id() != request.observation_id || !stage.is_activity() {
            return Ok(reject("link_stage_binding_mismatch"));
        }
        if request.discard.unwrap_or(false) {
            if stage.started {
                return Ok(reject("link_stage_already_dispatched"));
            }
            stages.0.remove_file(slot_name(slot))?;
            return Ok(CaptureOutcome::Suppressed {
                reason: "link_stage_discarded".into(),
            });
        }
        let checked = stage.checked.for_publication(None);
        if !config.snapshot().capture_enabled || super::shape(&checked.observation, true).is_err() {
            return Ok(reject("link_policy_changed"));
        }
        let store = capture_store(config)?;
        if !stage.started {
            stage.started = true;
            stages.save(slot, &stage)?;
        }
        let result = store.record_staged_links(checked, |observation, source| {
            freeze_publication(&stages, slot, &mut stage, observation, source)
        });
        if accepted(&result) && stage.published.is_none() {
            stage.published = Some(OffsetDateTime::now_utc().unix_timestamp());
            let _ = stages.save(slot, &stage);
        }
        Ok(result)
    };
    let mut attempt = attempt;
    let (outcome, reason, relative_path) = match attempt() {
        Ok(CaptureOutcome::Persisted { relative_path }) => (
            VisitOutcome::Persisted,
            None,
            Some(relative_path.to_string_lossy().into_owned()),
        ),
        Ok(CaptureOutcome::Suppressed { reason }) => (VisitOutcome::Suppressed, Some(reason), None),
        Ok(CaptureOutcome::Rejected { reason }) => (VisitOutcome::Rejected, Some(reason), None),
        _ => (
            VisitOutcome::Retryable,
            Some("link publication unavailable".into()),
            None,
        ),
    };
    Response::OutboundLinksRecorded(OutboundLinksRecorded {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id,
        observation_id: request.observation_id,
        outcome,
        reason,
        relative_path,
    })
}

fn reject(reason: &str) -> CaptureOutcome {
    CaptureOutcome::Rejected {
        reason: reason.into(),
    }
}

/// Persist the digest of the final bounded observation and its exact source
/// before the checked writer starts. A retry that sees different inherited
/// provenance or different encoded bytes cannot publish under this ID.
fn freeze_publication(
    stages: &Stages,
    slot: usize,
    stage: &mut Stage,
    observation: &CheckedObservation,
    source: &SourceCapture,
) -> Result<bool> {
    let frozen = FrozenPublication {
        source_fingerprint: source.fingerprint.clone(),
        observation_digest: hex::encode(Sha256::digest(serde_json::to_vec(observation)?)),
    };
    if let Some(prior) = &stage.frozen {
        return Ok(prior == &frozen);
    }
    stage.frozen = Some(frozen);
    stages.save(slot, stage)?;
    Ok(true)
}

#[cfg(unix)]
pub(crate) fn bind_summary(
    config: &mut ConfigStore,
    token: &str,
    run: Uuid,
    raw_url: &str,
) -> Result<()> {
    let _lock = config.lock_current()?;
    refresh(config)?;
    let stages = Stages::open(config, false)?;
    let (slot, mut stage) = stages.lookup(token)?;
    let canonical =
        super::safe_url(raw_url, &config.snapshot().strip_params).map_err(anyhow::Error::msg)?;
    let key = crate::native::resolve_record_key(config, raw_url)
        .map_err(|_| anyhow::anyhow!("summary source identity unavailable"))?;
    ensure!(
        stage.current(config, OffsetDateTime::now_utc().unix_timestamp())
            && !stage.is_activity()
            && stage.checked.draft.source_url == canonical.url
            && stage.summary_key.as_ref() == Some(&key)
            && stage.run.is_none(),
        "link stage cannot bind to summary"
    );
    stage.run = Some(run.to_string());
    stages.save(slot, &stage)
}

#[cfg(unix)]
pub(crate) fn discard_join(config: &ConfigStore, token: &str) -> Result<()> {
    let _lock = config.lock_current()?;
    let stages = Stages::open(config, false)?;
    let (slot, stage) = stages.lookup(token)?;
    if stage.run.is_none() && !stage.is_activity() {
        stages.0.remove_file(slot_name(slot))?;
    }
    Ok(())
}

/// Freeze the finisher's source candidate before the capture append. On a
/// crash or write error a drain can publish only after the exact marker
/// exists. A failed save can use a new stamp if its earlier source never
/// became durable.
#[cfg(unix)]
pub(crate) fn freeze_summary(
    config: &ConfigStore,
    run_dir: &Path,
    store: &CaptureStore,
    key: &brauser_protocol::RecordKey,
    source: OutboundLinkSource,
) -> Result<Option<String>> {
    let runs = Dir::open_ambient_dir(run_dir, cap_std::ambient_authority())?;
    let Some(data) = read(&runs, RUN_SIDECAR, 64)? else {
        return Ok(None);
    };
    let token: String = serde_json::from_slice(&data)?;
    let stages = Stages::open(config, false)?;
    let (slot, mut stage) = stages.lookup(&token)?;
    ensure!(
        stage.current(config, OffsetDateTime::now_utc().unix_timestamp())
            && stage.run.as_deref() == Some(source.event_id.as_str())
            && !stage.is_activity()
            && stage.summary_key.as_ref() == Some(key)
            && stage.checked.draft.source_url == source.url,
        "link stage no longer matches summary"
    );
    super::shape(&observation(&stage.checked.draft, Some(&source)), true)
        .map_err(anyhow::Error::msg)?;
    let prior = stage.summary_source();
    if prior.as_ref() != Some(&source) {
        ensure!(
            stage.frozen.is_none(),
            "link stage publication was already dispatched"
        );
        if let Some(previous) = prior.as_ref() {
            ensure!(
                store.link_source(previous)?.is_none(),
                "link stage source is already durable"
            );
        }
        stage.summary_at = Some(source.occurred_at);
        stages.save(slot, &stage)?;
    }
    Ok(Some(token))
}

fn publish_summary(
    config: &ConfigStore,
    store: &CaptureStore,
    stages: &Stages,
    slot: usize,
    mut stage: Stage,
) -> Result<Option<(i64, String)>> {
    let Some(source) = stage.summary_source() else {
        return Ok(None);
    };
    if !stage.current(config, OffsetDateTime::now_utc().unix_timestamp()) {
        return Ok(None);
    }
    if let Some(published) = stage.published {
        return Ok(Some((published, stage.id().into())));
    }
    if stage.run.as_deref() != Some(&source.event_id)
        || source.kind != OutboundLinkSourceKind::Summary
        || stage.is_activity()
        || stage.checked.draft.source_url != source.url
    {
        return Ok(None);
    }
    let checked = stage.checked.for_publication(Some(&source));
    if super::shape(&checked.observation, true).is_err() {
        return Ok(None);
    }
    let outcome = store.record_staged_links(checked, |observation, source| {
        freeze_publication(stages, slot, &mut stage, observation, source)
    });
    if !accepted(&outcome) {
        return Ok(None);
    }
    let published = OffsetDateTime::now_utc().unix_timestamp();
    stage.published = Some(published);
    stages.save(slot, &stage)?;
    Ok(Some((published, stage.id().into())))
}

// A wall or canceled run has no source to recover. Look up only the run
// named by a bounded slot, never enumerate retained runs or their outputs.
fn summary_ended_without_source(config: &ConfigStore, stage: &Stage) -> Result<bool> {
    let Some(id) = stage
        .run
        .as_deref()
        .filter(|id| canonical_uuid(id).is_some())
    else {
        return Ok(false);
    };
    let root = Dir::open_ambient_dir(config.dir()?, cap_std::ambient_authority())?;
    let run_root = Path::new(crate::brand::RUNS_DIR).join(id);
    if !root
        .symlink_metadata(&run_root)
        .is_ok_and(|meta| meta.is_dir())
    {
        return Ok(false);
    }
    let dir = root.open_dir(run_root)?;
    let Some(bytes) = read(&dir, "status.json", 128 * 1024)? else {
        return Ok(false);
    };
    #[derive(Deserialize)]
    struct Status {
        run_id: String,
        state: brauser_protocol::RunState,
        error_kind: Option<brauser_protocol::RunErrorKind>,
        summary_path: Option<String>,
    }
    let status: Status = serde_json::from_slice(&bytes)?;
    use brauser_protocol::{RunErrorKind, RunState};
    Ok(status.run_id == id
        && match status.state {
            RunState::Canceled => true,
            RunState::Failed => status.error_kind != Some(RunErrorKind::SaveFailed),
            RunState::Succeeded => status.summary_path.is_none(),
            RunState::Queued | RunState::Running => false,
        })
}

#[cfg(unix)]
pub(crate) fn finish_summary(
    config: &ConfigStore,
    store: &CaptureStore,
    token: &str,
) -> Result<()> {
    let stages = Stages::open(config, false)?;
    let (slot, stage) = stages.lookup(token)?;
    publish_summary(config, store, &stages, slot, stage)?;
    Ok(())
}

pub(crate) fn drain(request: DrainOutboundLinksRequest, config: &mut ConfigStore) -> Response {
    let outcome = (|| -> Result<(bool, Option<(String, String)>)> {
        let _lock = config.lock_current()?;
        refresh(config)?;
        let stages = match Stages::open(config, false) {
            Ok(stages) => stages,
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                return Ok((false, None));
            }
            Err(error) => return Err(error),
        };
        let store = capture_store(config)?;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let start = (now.div_euclid(60).rem_euclid(STAGES as i64)) as usize;
        let mut newest: Option<(i64, String)> = None;
        let mut attempted = 0;
        let mut pending = false;
        for offset in 0..STAGES {
            let slot = (start + offset) % STAGES;
            let Ok(Some(stage)) = stages.load(slot) else {
                continue;
            };
            if stage.is_activity() || !stage.current(config, now) {
                continue;
            }
            if stage.published.is_none() {
                if stage.summary_at.is_none()
                    && summary_ended_without_source(config, &stage).unwrap_or(false)
                {
                    let _ = stages.0.remove_file(slot_name(slot));
                    continue;
                }
                if attempted == SUMMARY_DRAIN_LIMIT || stage.summary_at.is_none() {
                    pending = true;
                    continue;
                }
                attempted += 1;
            }
            match publish_summary(config, &store, &stages, slot, stage) {
                Ok(Some(receipt)) => {
                    if newest.as_ref().is_none_or(|prior| prior < &receipt) {
                        newest = Some(receipt);
                    }
                }
                _ => pending = true,
            }
        }
        Ok((
            pending,
            newest.map(|(_, id)| (id, config.revision().into())),
        ))
    })();
    let (pending, outcome) = outcome.unwrap_or((true, None));
    let (observation_id, policy_revision) = match outcome {
        Some((id, revision)) => (Some(id), Some(revision)),
        None => (None, None),
    };
    Response::OutboundLinksDrained(OutboundLinksDrained {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id,
        observation_id,
        policy_revision,
        pending,
    })
}
