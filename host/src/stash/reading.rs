//! Reading transitions keep the first Done receipt as a baseline. Each later
//! transition claims the previous version's filename with a create-only link.
use std::{collections::HashSet, io};

use anyhow::{Result, bail};
use cap_std::fs::Dir;

use super::{
    SCAN_LIMIT, Unavailable, digest, publish_checked_in, read_bounded, sync_directory, valid_id,
};
use crate::vault::open_plain_child;

const DIRECTORY: &str = ".brauser-stash-reading";
const MAX_RECEIPT_BYTES: u64 = 1024;

pub(super) struct State {
    pub(super) done: bool,
    pub(super) version: String,
    pub(super) previous: Option<String>,
    directory_entries: usize,
}

pub(super) fn directory(stash: &Dir, create: bool) -> Result<Option<Dir>> {
    open_directory(stash, DIRECTORY, create)
}

pub(super) fn entry(journal: Option<&Dir>, id: &str, create: bool) -> Result<Option<Dir>> {
    let Some(journal) = journal else {
        return Ok(None);
    };
    open_directory(journal, id, create)
}

fn open_directory(parent: &Dir, name: &str, create: bool) -> Result<Option<Dir>> {
    if create {
        match parent.create_dir(name) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        sync_directory(parent)?;
    }
    match open_plain_child(parent, name) {
        Ok(dir) => Ok(Some(dir)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
            Err(Unavailable::Occupied.into())
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) fn baseline(id: &str, entry: &str, done: bool) -> State {
    State {
        done,
        version: digest(
            format!("brauser.stash.reading.baseline.v1\n{id}\n{entry}\n{done}\n").as_bytes(),
        ),
        previous: None,
        directory_entries: 0,
    }
}

fn name(previous: &str) -> String {
    format!("{previous}.md")
}

fn receipt(id: &str, entry: &str, previous: &str, done: bool) -> String {
    format!(
        "---\nbrauser:\n  kind: stash_reading\n  format: 1\n  stash_id: \"{id}\"\n  entry_sha256: \"{entry}\"\n  previous: \"{previous}\"\n  done: {done}\n---\n"
    )
}

pub(super) fn current(
    dir: Option<&Dir>,
    id: &str,
    entry: &str,
    legacy_done: bool,
) -> Result<State> {
    let mut state = baseline(id, entry, legacy_done);
    let Some(dir) = dir else {
        return Ok(state);
    };
    // Snapshot the live slot names. A retained successor with a missing
    // predecessor must never revive an older version or accept a stale write.
    let mut slots = HashSet::new();
    for file in dir.entries()? {
        state.directory_entries += 1;
        if state.directory_entries > SCAN_LIMIT {
            bail!(Unavailable::ScanLimit);
        }
        let name = file?.file_name();
        if let Some(version) = name.to_str().and_then(|name| name.strip_suffix(".md"))
            && valid_id(version)
        {
            slots.insert(version.to_owned());
        }
    }
    if !legacy_done && !slots.is_empty() {
        bail!(Unavailable::Occupied);
    }
    while !slots.is_empty() {
        if !slots.remove(&state.version) {
            bail!(Unavailable::Occupied);
        }
        let bytes = read_bounded(dir, &name(&state.version), MAX_RECEIPT_BYTES)?
            .ok_or(Unavailable::Occupied)?;
        let done = !state.done;
        if bytes != receipt(id, entry, &state.version, done).as_bytes() {
            bail!(Unavailable::Occupied);
        }
        state.done = done;
        state.previous = Some(std::mem::replace(&mut state.version, digest(&bytes)));
    }
    Ok(state)
}

pub(super) fn append(
    staging: &Dir,
    dir: &Dir,
    id: &str,
    entry: &str,
    before: State,
    check: impl FnOnce() -> Result<()>,
) -> Result<State> {
    if before.directory_entries >= SCAN_LIMIT {
        bail!(Unavailable::ScanLimit);
    }
    let done = !before.done;
    let record = receipt(id, entry, &before.version, done);
    // Stage in the parent so even a crash after linking cannot use a second
    // slot in the bounded history. Recheck after staging and the scope check.
    publish_checked_in(staging, dir, &name(&before.version), &record, || {
        check()?;
        let entries = dir
            .entries()?
            .take(SCAN_LIMIT)
            .try_fold(0, |count, file| file.map(|_| count + 1))?;
        if entries >= SCAN_LIMIT {
            bail!(Unavailable::ScanLimit);
        }
        Ok(())
    })?;
    Ok(State {
        done,
        version: digest(record.as_bytes()),
        previous: Some(before.version),
        directory_entries: before.directory_entries + 1,
    })
}
