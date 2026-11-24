//! Checked content access for the private Stash search experiment.

use std::io::{self, Read};
use std::path::Path;

use anyhow::{Result, bail, ensure};
use brauser_protocol::RecordKey;
use cap_std::fs::{Dir, Metadata, OpenOptions};

use super::{FoundSummary, MAX_OWNED_FILE_BYTES, Vault, file_id, note_filename, open_plain_child};
use crate::layout::{NOTES_DIR, SUMMARIES_DIR};
use crate::summary::{owned_summary, summary_filename, summary_summarized_at};

pub(crate) const MAX_READ_BYTES: u64 = MAX_OWNED_FILE_BYTES as u64 + 1;

pub(crate) struct Scope {
    pub(crate) home: String,
    summaries: Option<Dir>,
    notes: Option<Dir>,
}

impl Vault {
    pub(crate) fn stash_search_scope(&self) -> Result<Scope> {
        let open = |name| match open_plain_child(&self.root, name) {
            Ok(dir) => Ok(Some(dir)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        };
        ensure!(
            self.pages_dir == Path::new(NOTES_DIR),
            "unexpected notes folder"
        );
        let summaries = match self.summaries_dir.as_deref() {
            Some(path) if path == Path::new(SUMMARIES_DIR) => open(SUMMARIES_DIR)?,
            Some(_) => bail!("unexpected summaries folder"),
            None => None,
        };
        Ok(Scope {
            home: crate::folder_identity::directory_identity(&self.root, None)?,
            summaries,
            notes: open(NOTES_DIR)?,
        })
    }
}

impl Scope {
    pub(crate) fn inspect_summary(
        &self,
        key: &RecordKey,
        url: &str,
    ) -> Result<Option<Occupant<'_>>> {
        Occupant::inspect(self.summaries.as_ref(), summary_filename(key, url)?)
    }

    pub(crate) fn inspect_note(&self, key: &RecordKey, url: &str) -> Result<Option<Occupant<'_>>> {
        Occupant::inspect(self.notes.as_ref(), note_filename(key, url)?)
    }
}

pub(crate) struct Occupant<'a> {
    dir: &'a Dir,
    name: String,
    inspected: Metadata,
}

impl<'a> Occupant<'a> {
    fn inspect(dir: Option<&'a Dir>, name: String) -> Result<Option<Self>> {
        let Some(dir) = dir else {
            return Ok(None);
        };
        let inspected = match dir.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        Ok(
            (inspected.is_file() && inspected.len() < MAX_READ_BYTES).then_some(Self {
                dir,
                name,
                inspected,
            }),
        )
    }

    pub(crate) fn reservation(&self) -> u64 {
        self.inspected.len() + 1
    }

    pub(crate) fn read(&self) -> Result<Vec<u8>> {
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
        let file = self.dir.open_with(&self.name, &options)?;
        let opened = file.metadata()?;
        ensure!(
            same_occupant(&self.inspected, &opened)?,
            "content changed before reading"
        );
        let mut bytes = Vec::new();
        (&file).take(self.reservation()).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == opened.len() && same_occupant(&opened, &file.metadata()?)?,
            "content changed while reading"
        );
        Ok(bytes)
    }

    pub(crate) fn read_summary(&self, key: &RecordKey) -> Result<FoundSummary> {
        let bytes = self.read()?;
        if !owned_summary(&bytes, key) {
            return Ok(FoundSummary::Unowned);
        }
        Ok(FoundSummary::Owned {
            relative: Path::new(SUMMARIES_DIR).join(&self.name),
            linked: format!("{SUMMARIES_DIR}/{}", self.name),
            summarized_at: summary_summarized_at(&bytes),
            bytes,
            file_id: file_id(&self.inspected),
        })
    }
}

fn same_occupant(first: &Metadata, second: &Metadata) -> io::Result<bool> {
    if !second.is_file() || first.len() != second.len() || first.modified()? != second.modified()? {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        Ok(file_id(first) == file_id(second)
            && (first.ctime(), first.ctime_nsec()) == (second.ctime(), second.ctime_nsec()))
    }
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        Ok(second.file_attributes() & REPARSE_POINT == 0)
    }
}
