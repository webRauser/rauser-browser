//! Reading transitions keep the first Done receipt as a baseline. Each later
//! transition claims the previous version's filename with a create-only link.
use std::io;

use anyhow::{Result, bail};
use cap_std::fs::Dir;

use super::{SCAN_LIMIT, Unavailable, digest, publish_checked, read_bounded, sync_directory};
use crate::vault::open_plain_child;

const DIRECTORY: &str = ".brauser-stash-reading";
const MAX_RECEIPT_BYTES: u64 = 1024;

pub(super) struct State {
    pub(super) done: bool,
    pub(super) version: String,
    pub(super) previous: Option<String>,
    count: usize,
}

pub(super) fn directory(stash: &Dir, create: bool) -> Result<Option<Dir>> {
    if create {
        match stash.create_dir(DIRECTORY) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        sync_directory(stash)?;
    }
    match open_plain_child(stash, DIRECTORY) {
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
        count: 0,
    }
}

fn name(id: &str, previous: &str) -> String {
    format!("{id}.{previous}.md")
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
    if !legacy_done {
        // If a journal exists for this saved entry, its historical Done receipt
        // must still be present. An absent or foreign receipt can't reset it.
        if read_bounded(
            dir,
            &name(id, &baseline(id, entry, true).version),
            MAX_RECEIPT_BYTES,
        )?
        .is_some()
        {
            bail!(Unavailable::Occupied);
        }
        return Ok(state);
    }
    for _ in 0..SCAN_LIMIT {
        let Some(bytes) = read_bounded(dir, &name(id, &state.version), MAX_RECEIPT_BYTES)? else {
            return Ok(state);
        };
        let done = !state.done;
        if bytes != receipt(id, entry, &state.version, done).as_bytes() {
            bail!(Unavailable::Occupied);
        }
        state = State {
            done,
            version: digest(&bytes),
            previous: Some(state.version),
            count: state.count + 1,
        };
    }
    if read_bounded(dir, &name(id, &state.version), MAX_RECEIPT_BYTES)?.is_none() {
        return Ok(state);
    }
    bail!(Unavailable::ScanLimit);
}

pub(super) fn append(
    dir: &Dir,
    id: &str,
    entry: &str,
    before: State,
    check: impl FnOnce() -> Result<()>,
) -> Result<State> {
    if before.count >= SCAN_LIMIT {
        bail!(Unavailable::ScanLimit);
    }
    let done = !before.done;
    let record = receipt(id, entry, &before.version, done);
    publish_checked(dir, &name(id, &before.version), &record, check)?;
    Ok(State {
        done,
        version: digest(record.as_bytes()),
        previous: Some(before.version),
        count: before.count + 1,
    })
}
