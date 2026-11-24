use super::*;
use crate::outbound_links::{
    CheckedObservation, MAX_OBSERVATION_BYTES, PreparedObservation, SourceCapture,
    StoredObservation, observation_key,
};

impl CaptureStore {
    pub(crate) fn record_links(&self, prepared: PreparedObservation) -> CaptureOutcome {
        match self.append_links(prepared) {
            Ok(outcome) => outcome,
            Err(_) => CaptureOutcome::Retryable {
                message: "link observation could not be saved".into(),
            },
        }
    }

    fn append_links(&self, mut prepared: PreparedObservation) -> Result<CaptureOutcome> {
        let _lock = lock_capture_file(&self.lock_path)?;
        // A reference never completes or manufactures its source. In
        // particular an unfinished batched source must first be redelivered.
        let Some(source) = self.link_source(&prepared.observation.source)? else {
            return Ok(CaptureOutcome::Rejected {
                reason: "link_source_not_found".into(),
            });
        };
        if prepared
            .source_identity
            .as_ref()
            .is_some_and(|(id, ty)| id != &source.artifact_id || ty != &source.artifact_type)
        {
            return Ok(CaptureOutcome::Rejected {
                reason: "link_source_identity_changed".into(),
            });
        }
        let source_before_recovery = source.clone();
        // A caller can supply the already-stripped spelling as its lookup
        // claim. It must not turn the source's known removal (or legacy
        // unknown evidence) into a new assertion that nothing was removed.
        if let Some(names) = source.stripped_params {
            prepared.provenance.url.extend(names);
            prepared.provenance.url.sort();
            prepared.provenance.url.dedup();
        } else {
            prepared.provenance.source_unknown = true;
        }
        let names = std::mem::take(&mut prepared.provenance.targets);
        let mut names = names.into_iter();
        prepared.observation.targets.retain(|target| {
            let target_names = names.next().expect("prepared positional evidence");
            if target.artifact_id == source.artifact_id {
                false
            } else {
                prepared.provenance.targets.push(target_names);
                true
            }
        });
        let checked = CheckedObservation {
            record: StoredObservation {
                observation: prepared.observation,
                source_artifact_id: source.artifact_id,
                source_artifact_type: source.artifact_type,
            },
            provenance: prepared.provenance,
        };
        if !checked.valid() {
            return Ok(CaptureOutcome::Rejected {
                reason: "invalid_link_observation".into(),
            });
        }
        let observation = &checked.record.observation;
        let timestamp = parse_event_time(&observation.observed_at).map_err(anyhow::Error::msg)?;
        let event = VisitEvent {
            event_id: observation.observation_id.clone(),
            url: observation.source.url.clone(),
            title: None,
            occurred_at: observation.observed_at.clone(),
            incognito: false,
        };
        let data = serde_json::to_vec(&checked.record)?;
        let metadata = format!(" kind=links_to data={}", hex::encode(data));
        let provenance = checked.provenance.marker();
        // Recover only after a complete accepted source was found, then bind
        // it again and check IDs against the settled log. Recovery must not
        // authorize an unfinished source or turn a restored activity into an
        // acknowledged observation with the same ID.
        self.recover_batch_intent()?;
        if self.link_source(&observation.source)?.as_ref() != Some(&source_before_recovery) {
            return Ok(CaptureOutcome::Rejected {
                reason: "link_source_not_found".into(),
            });
        }
        let event_key = observation_key(&observation.observation_id);
        let event_hash = sha256_hex(event_key.as_bytes());
        let expected = visit_payload_hash(&event_key, &event.url, &event, &metadata, &provenance);
        let intent = read_intent(&self.journal_path(&event_hash))?;
        if intent.as_ref().is_some_and(|intent| {
            intent.version != 3 || intent.payload_hash.as_deref() != Some(expected.current.as_str())
        }) {
            return Ok(CaptureOutcome::Rejected {
                reason: "link_observation_id_conflict".into(),
            });
        }
        if intent.as_ref().is_some_and(|intent| {
            !intent.entry.as_deref().is_some_and(|entry| {
                entry.len() <= MAX_VISIT_ENTRY_BYTES
                    && complete_entry_len(entry.as_bytes()) == Some(entry.len())
                    && intent.entry_hash == sha256_hex(entry.as_bytes())
                    && entry.lines().find_map(links_marker).as_ref() == Some(&checked)
            })
        }) {
            return Ok(CaptureOutcome::Rejected {
                reason: "invalid_link_journal".into(),
            });
        }
        // Only an identical, checked observation in this domain can justify
        // duplicate success; a legacy capture with the same UUID cannot.
        if let Some(text) = self.read_link_day(timestamp)? {
            let prefix = format!("{MARKER_PREFIX}{event_hash}");
            for line in text.lines() {
                let own = line.starts_with(&prefix);
                let torn_replay = own && intent.is_some() && !line.ends_with(" -->");
                let parsed = links_marker(line);
                if line.starts_with(MARKER_PREFIX)
                    && line.contains(" kind=links_to")
                    && !torn_replay
                    && parsed.is_none()
                {
                    return Ok(CaptureOutcome::Rejected {
                        reason: "invalid_link_marker".into(),
                    });
                }
                if own && !torn_replay && parsed.as_ref() != Some(&checked) {
                    return Ok(CaptureOutcome::Rejected {
                        reason: "link_observation_id_conflict".into(),
                    });
                }
            }
        }
        let body = format!(
            "{} — Outbound artifact links ({})",
            observation.observed_at,
            observation.targets.len()
        );
        self.record_authorized_locked(
            &event_key,
            timestamp,
            &event.url,
            &event,
            EventRendering {
                body: Some(&body),
                marker_metadata: Some(&metadata),
                exact_replay: true,
                urls_within_bound: true,
                provenance,
            },
        )
    }

    /// Inspect exactly the source's host-derived day path in this selected
    /// physical home. Refuse symlinks, unowned files, damaged/ambiguous bodies
    /// and changed spelling; neither a journal nor a cache is source evidence.
    fn link_source(
        &self,
        reference: &brauser_protocol::OutboundLinkSource,
    ) -> Result<Option<SourceCapture>> {
        let at = parse_event_time(&reference.occurred_at).map_err(anyhow::Error::msg)?;
        let text = match self.read_link_day(at) {
            Ok(Some(text)) => text,
            _ => return Ok(None),
        };
        let prefix = format!(
            "{MARKER_PREFIX}{}",
            sha256_hex(reference.event_id.as_bytes())
        );
        let mut found: Option<SourceCapture> = None;
        for line in text.split_inclusive('\n') {
            if !line.starts_with(&prefix) {
                continue;
            }
            if !line.ends_with('\n') {
                return Ok(None);
            }
            let Some(source) = crate::index::source_capture(line.trim_end_matches(['\r', '\n']))
            else {
                return Ok(None);
            };
            if source.kind != reference.kind
                || source.event_id != reference.event_id
                || source.occurred_at != reference.occurred_at
                || source.url != reference.url
                || found.as_ref().is_some_and(|previous| previous != &source)
            {
                return Ok(None);
            }
            found = Some(source);
        }
        Ok(found)
    }

    fn read_link_day(&self, at: OffsetDateTime) -> Result<Option<String>> {
        let (relative_dir, filename) = self.log_parts(at);
        let mut directory = self.root.try_clone()?;
        for component in relative_dir.components() {
            let name = component.as_os_str();
            match directory.symlink_metadata(name) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                _ => bail!("link log parent is not a regular directory"),
            }
            directory = directory.open_dir(name)?;
        }
        let metadata = match directory.symlink_metadata(&filename) {
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= MAX_LOG_BYTES =>
            {
                metadata
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            _ => bail!("link log is not a bounded regular file"),
        };
        let mut file = directory.open(&filename)?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_LOG_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != metadata.len() || file.metadata()?.len() != metadata.len() {
            bail!("link log changed during inspection");
        }
        let text = String::from_utf8_lossy(&bytes);
        if text.lines().next() != Some(LOG_HEADER) {
            bail!("link log is unowned");
        }
        Ok(Some(text.into_owned()))
    }
}

/// Strict capture-time reader, shared by history/relearning and later index
/// projection. Unknown old records remain readable without new evidence.
pub(crate) fn links_marker(line: &str) -> Option<CheckedObservation> {
    if line.len() > 2 * MAX_OBSERVATION_BYTES + 1024 {
        return None;
    }
    let rest = line.strip_prefix(MARKER_PREFIX)?.strip_suffix(" -->")?;
    let fields: Vec<_> = rest.split(' ').collect();
    if fields.len() != 6 || fields[3] != "kind=links_to" {
        return None;
    }
    let data = fields[4].strip_prefix("data=")?;
    let names = fields[5].strip_prefix("stripped=")?;
    if data.len().checked_add(names.len())? > 2 * MAX_OBSERVATION_BYTES {
        return None;
    }
    let record: StoredObservation = serde_json::from_slice(&hex::decode(data).ok()?).ok()?;
    let provenance: UrlProvenance = serde_json::from_slice(&hex::decode(names).ok()?).ok()?;
    let checked = CheckedObservation { record, provenance };
    let o = &checked.record.observation;
    if fields[0] != sha256_hex(observation_key(&o.observation_id).as_bytes())
        || fields[1].strip_prefix("url=")? != sha256_hex(o.source.url.as_bytes())
        || fields[2].strip_prefix("at=")? != o.observed_at
        || !checked.valid()
    {
        return None;
    }
    Some(checked)
}
