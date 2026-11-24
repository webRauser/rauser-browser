//! Independent, create-only pin history for the selected Stash home.

use std::{collections::HashMap, io};

use anyhow::{Result, bail};
use brauser_protocol::StashPin;
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use super::{Unavailable, digest, publish, read_bounded, valid_id};
use crate::{
    folder_identity::directory_identity,
    vault::{Vault, sync_directory},
};

const MARKER: &str = "stash-pins.owner";
const FORMAT: u32 = 1;
const MAX_RECORD_BYTES: u64 = 1024;
const MAX_CHANGES: usize = 10_000;
// Count abandoned staging names too, while allowing a few interrupted writes.
const MAX_NAMES: usize = MAX_CHANGES + 32;

fn read_record(dir: &Dir, name: &str) -> Result<Option<Vec<u8>>> {
    read_bounded(dir, name, MAX_RECORD_BYTES).map_err(|error| {
        if matches!(error.downcast_ref(), Some(Unavailable::Occupied)) {
            Unavailable::PinHistory.into()
        } else {
            error
        }
    })
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ownership {
    format: u32,
    home: String,
    nonce: String,
    directory: String,
}

impl Ownership {
    fn name(nonce: &str) -> String {
        format!("stash-pins-{nonce}")
    }

    fn open(&self, vault: &Vault) -> Result<Dir> {
        let root = vault.stash_pin_parent();
        if self.format != FORMAT
            || !is_nonce(&self.nonce)
            || directory_identity(root, Some(&self.home))? != self.home
        {
            bail!(Unavailable::PinHistory);
        }
        let dir = match vault.open_stash_pin_directory(&Self::name(&self.nonce)) {
            Ok(dir) => dir,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::InvalidData
                ) =>
            {
                bail!(Unavailable::PinHistory);
            }
            Err(error) => return Err(error.into()),
        };
        if directory_identity(&dir, Some(&self.directory))? != self.directory {
            bail!(Unavailable::PinHistory);
        }
        Ok(dir)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    namespace: String,
    slot: usize,
    id: String,
    entry_version: String,
    previous: String,
    pinned: bool,
}

struct Head {
    change: Change,
    version: String,
}

impl Head {
    fn pin(&self) -> StashPin {
        StashPin {
            pinned: self.change.pinned,
            version: self.version.clone(),
        }
    }
}

fn initial_version(id: &str, entry_version: &str) -> String {
    digest(format!("brauser.stash.pin.initial:{id}:{entry_version}").as_bytes())
}

fn seal(kind: &str, record: &impl Serialize) -> Result<String> {
    let body = serde_json::to_string(record)?;
    let checksum = digest(format!("{kind}\n{body}").as_bytes());
    Ok(format!("{kind}\n{body}\n{checksum}\n"))
}

fn unseal<T: DeserializeOwned + Serialize>(kind: &str, bytes: &[u8]) -> Result<T> {
    let text = std::str::from_utf8(bytes).map_err(|_| Unavailable::PinHistory)?;
    let body = text.lines().nth(1).ok_or(Unavailable::PinHistory)?;
    let record = serde_json::from_str(body).map_err(|_| Unavailable::PinHistory)?;
    if seal(kind, &record)? != text {
        bail!(Unavailable::PinHistory);
    }
    Ok(record)
}

const OWNER_KIND: &str = "brauser.stash.pin.owner";
const CHANGE_KIND: &str = "brauser.stash.pin.change";

fn slot_name(slot: usize) -> String {
    format!("{slot:05}.pin")
}

fn is_nonce(nonce: &str) -> bool {
    Uuid::parse_str(nonce)
        .is_ok_and(|id| id.get_version_num() == 4 && id.hyphenated().to_string() == nonce)
}

fn is_staging_name(name: &str) -> bool {
    name.strip_prefix(".stash-")
        .and_then(|name| name.strip_suffix(".tmp"))
        .is_some_and(is_nonce)
}

struct Namespace {
    ownership: Ownership,
    version: String,
    dir: Dir,
}

impl Namespace {
    fn open(vault: &Vault) -> Result<Option<Self>> {
        let Some(bytes) = read_record(vault.stash_pin_parent(), MARKER)? else {
            return Ok(None);
        };
        let ownership: Ownership = unseal(OWNER_KIND, &bytes)?;
        let dir = ownership.open(vault)?;
        Ok(Some(Self {
            ownership,
            version: digest(&bytes),
            dir,
        }))
    }

    fn create(vault: &Vault) -> Result<Self> {
        let root = vault.stash_pin_parent();
        let nonce = Uuid::new_v4().to_string();
        let name = Ownership::name(&nonce);
        // Create a fresh name. An interrupted setup can leave an unattached
        // directory, which a future setup never takes over or removes.
        root.create_dir(&name)?;
        let dir = vault.open_stash_pin_directory(&name)?;
        if dir.entries()?.next().transpose()?.is_some() {
            bail!(Unavailable::PinHistory);
        }
        let ownership = Ownership {
            format: FORMAT,
            home: directory_identity(root, None)?,
            nonce,
            directory: directory_identity(&dir, None)?,
        };
        let contents = seal(OWNER_KIND, &ownership)?;
        sync_directory(&dir)?;
        publish(root, MARKER, &contents)?;
        let namespace = Self {
            ownership,
            version: digest(contents.as_bytes()),
            dir,
        };
        namespace.check_attached(vault)?;
        Ok(namespace)
    }

    fn check_attached(&self, vault: &Vault) -> Result<()> {
        let bytes =
            read_record(vault.stash_pin_parent(), MARKER)?.ok_or(Unavailable::PinHistory)?;
        if digest(&bytes) != self.version {
            bail!(Unavailable::PinHistory);
        }
        self.ownership.open(vault)?;
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct Pins {
    namespace: Option<Namespace>,
    count: usize,
    names_seen: usize,
    last_change: Option<String>,
    heads: HashMap<String, Head>,
}

impl Pins {
    pub(super) fn load(vault: &Vault) -> Result<Self> {
        let Some(namespace) = Namespace::open(vault)? else {
            return Ok(Self::default());
        };
        let mut names = Vec::new();
        let mut names_seen = 0;
        for file in namespace.dir.entries()? {
            names_seen += 1;
            if names_seen > MAX_NAMES {
                bail!(Unavailable::ScanLimit);
            }
            let name = file?
                .file_name()
                .into_string()
                .map_err(|_| Unavailable::PinHistory)?;
            if !is_staging_name(&name) {
                names.push(name);
            }
        }
        if names.len() > MAX_CHANGES {
            bail!(Unavailable::ScanLimit);
        }
        names.sort_unstable();
        let mut heads: HashMap<String, Head> = HashMap::new();
        let mut last_change = None;
        for (slot, name) in names.iter().enumerate() {
            if *name != slot_name(slot) {
                bail!(Unavailable::PinHistory);
            }
            let bytes = read_record(&namespace.dir, name)?.ok_or(Unavailable::PinHistory)?;
            let change: Change = unseal(CHANGE_KIND, &bytes)?;
            if change.slot != slot
                || change.namespace != namespace.version
                || !valid_id(&change.id)
                || !valid_id(&change.entry_version)
            {
                bail!(Unavailable::PinHistory);
            }
            let valid_transition = match heads.get(&change.id) {
                Some(head) => {
                    change.entry_version == head.change.entry_version
                        && change.previous == head.version
                        && change.pinned != head.change.pinned
                }
                None => {
                    change.pinned
                        && change.previous == initial_version(&change.id, &change.entry_version)
                }
            };
            if !valid_transition {
                bail!(Unavailable::PinHistory);
            }
            let version = digest(&bytes);
            if slot + 1 == names.len() {
                last_change = Some(version.clone());
            }
            heads.insert(change.id.clone(), Head { change, version });
        }
        namespace.check_attached(vault)?;
        Ok(Self {
            namespace: Some(namespace),
            heads,
            count: names.len(),
            names_seen,
            last_change,
        })
    }

    pub(super) fn order_version(&self) -> Option<&str> {
        self.last_change.as_deref()
    }

    fn head(&self, id: &str, entry_version: &str) -> Result<Option<&Head>> {
        let head = self.heads.get(id);
        if head.is_some_and(|head| head.change.entry_version != entry_version) {
            bail!(Unavailable::PinHistory);
        }
        Ok(head)
    }

    pub(super) fn pinned(&self, id: &str, entry_version: &str) -> Result<bool> {
        Ok(self
            .head(id, entry_version)?
            .is_some_and(|head| head.change.pinned))
    }

    pub(super) fn view(&self, id: &str, entry_version: &str) -> Result<StashPin> {
        Ok(match self.head(id, entry_version)? {
            Some(head) => head.pin(),
            None => StashPin {
                pinned: false,
                version: initial_version(id, entry_version),
            },
        })
    }

    pub(super) fn set(
        self,
        vault: &Vault,
        id: &str,
        entry_version: &str,
        expected: &str,
        pinned: bool,
    ) -> Result<StashPin> {
        let current = self.view(id, entry_version)?;
        let replay = self
            .head(id, entry_version)?
            .is_some_and(|head| head.change.previous == expected && current.pinned == pinned);
        if expected != current.version && !replay {
            bail!(Unavailable::Changed);
        }
        if current.pinned == pinned {
            if let Some(namespace) = &self.namespace {
                // A response may have been lost after publication but before
                // the directory sync. Confirm the existing names are durable.
                sync_directory(&namespace.dir)?;
                sync_directory(vault.stash_pin_parent())?;
                namespace.check_attached(vault)?;
            }
            return Ok(current);
        }
        // Reserve the final name and the staging name, which may remain
        // after an interruption. An accepted change must remain readable.
        if self.count >= MAX_CHANGES || self.names_seen > MAX_NAMES - 2 {
            bail!(Unavailable::ScanLimit);
        }
        let namespace = match self.namespace {
            Some(namespace) => namespace,
            None => Namespace::create(vault)?,
        };
        sync_directory(vault.stash_pin_parent())?;
        let change = Change {
            namespace: namespace.version.clone(),
            slot: self.count,
            id: id.into(),
            entry_version: entry_version.into(),
            previous: current.version,
            pinned,
        };
        let contents = seal(CHANGE_KIND, &change)?;
        let name = slot_name(change.slot);
        namespace.check_attached(vault)?;
        publish(&namespace.dir, &name, &contents)?;
        let verified = read_record(&namespace.dir, &name)?.ok_or(Unavailable::PinHistory)?;
        if verified != contents.as_bytes() {
            bail!(Unavailable::PinHistory);
        }
        namespace.check_attached(vault)?;
        Ok(StashPin {
            pinned,
            version: digest(&verified),
        })
    }
}
