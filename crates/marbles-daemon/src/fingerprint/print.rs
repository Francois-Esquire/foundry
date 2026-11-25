use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::tree::{MISSING, tree_files};
use super::{FileDigests, WorkspaceRegistration, hex};

const CHANGED: &str = "changed since it was read";
const ABSENT: &str = "absent";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePrint {
    pub root: PathBuf,
    pub tree: String,
    pub files: BTreeMap<String, String>,
    pub outside: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub digest: String,
    pub installation: String,
    pub sources: BTreeMap<String, WorkspacePrint>,
}

impl WorkspacePrint {
    pub fn source_digest(&self, id: &str) -> String {
        Fingerprint::of("", BTreeMap::from([(id.to_owned(), self.clone())])).digest
    }

    fn covers(&self, file: &Path) -> bool {
        file.strip_prefix(&self.root)
            .ok()
            .map(|relative| relative.display().to_string())
            .is_some_and(|relative| !relative.is_empty() && self.files.contains_key(&relative))
    }

    pub fn read_digest(
        &self,
        file: &str,
        read_at: u64,
        digests: &mut FileDigests,
    ) -> Option<String> {
        if self.covers(Path::new(file)) || self.outside.contains_key(file) {
            return None;
        }
        let unchanged =
            FileDigests::modified_ms(Path::new(file)).is_some_and(|modified| modified < read_at);
        let digest = unchanged
            .then(|| digests.of(Path::new(file)))
            .flatten()
            .unwrap_or_else(|| CHANGED.to_owned());
        Some(digest)
    }

    pub fn with_read(&self, file: &str, read_at: u64, digests: &mut FileDigests) -> Option<Self> {
        let digest = self.read_digest(file, read_at, digests)?;
        Some(self.with_outside(file, digest))
    }

    pub fn with_outside(&self, file: &str, digest: String) -> Self {
        let mut next = self.clone();
        next.outside.entry(file.to_owned()).or_insert(digest);
        next
    }
}

pub fn print_now<'a>(
    registration: &WorkspaceRegistration,
    outside: impl IntoIterator<Item = &'a String>,
    digests: &mut FileDigests,
    ignored: &HashSet<PathBuf>,
    limit: usize,
) -> WorkspacePrint {
    let tree = tree_files(registration, digests, ignored, limit);
    let outside = outside
        .into_iter()
        .map(|file| {
            let digest = digests
                .of(Path::new(file))
                .unwrap_or_else(|| MISSING.to_owned());
            (file.clone(), digest)
        })
        .collect();
    WorkspacePrint {
        tree: digest_of_tree(&tree.files),
        root: tree.root,
        files: tree.files,
        outside,
    }
}

fn digest_of_tree(files: &BTreeMap<String, String>) -> String {
    let mut hash = Sha256::new();
    for (path, digest) in files {
        hash.update(format!("\0{path}\0{digest}"));
    }
    hex(&hash.finalize())
}

impl Fingerprint {
    pub fn of(installation: &str, sources: BTreeMap<String, WorkspacePrint>) -> Self {
        let mut hash = Sha256::new();
        hash.update(installation);
        for (id, print) in &sources {
            hash.update(format!("\0{id}\0{}", print.tree));
            for (file, digest) in &print.outside {
                hash.update(format!("\0{file}\0{digest}"));
            }
        }
        Self {
            digest: hex(&hash.finalize()),
            installation: installation.to_owned(),
            sources,
        }
    }

    pub fn with_source(&self, id: &str, print: Option<WorkspacePrint>) -> Self {
        let mut sources = self.sources.clone();
        match print {
            Some(print) => sources.insert(id.to_owned(), print),
            None => sources.remove(id),
        };
        Self::of(&self.installation, sources)
    }

    pub fn watching(&self, watched: Option<&Self>) -> Self {
        let Some(watched) = watched else {
            return self.clone();
        };
        let sources = self
            .sources
            .iter()
            .map(|(id, print)| {
                let mut outside = watched
                    .sources
                    .get(id)
                    .map(|kept| kept.outside.clone())
                    .unwrap_or_default();
                outside.extend(print.outside.clone());
                (
                    id.clone(),
                    WorkspacePrint {
                        outside,
                        ..print.clone()
                    },
                )
            })
            .collect();
        Self::of(&self.installation, sources)
    }

    pub fn edited(&self, other: &Self, id: &str) -> bool {
        match (self.sources.get(id), other.sources.get(id)) {
            (Some(was), Some(now)) => was.source_digest(id) != now.source_digest(id),
            _ => true,
        }
    }
}

pub fn differences(was: &Fingerprint, now: &Fingerprint) -> Vec<String> {
    let mut lines = Vec::new();
    if was.installation != now.installation {
        lines.push("the installation changed".to_owned());
    }
    let ids: BTreeSet<&String> = was.sources.keys().chain(now.sources.keys()).collect();
    for id in ids {
        let (before, after) = match (was.sources.get(id), now.sources.get(id)) {
            (Some(before), Some(after)) => (before, after),
            (None, _) => {
                lines.push(format!("workspace {id} added"));
                continue;
            }
            (_, None) => {
                lines.push(format!("workspace {id} removed"));
                continue;
            }
        };
        for (label, one, other) in [
            ("under its root", &before.files, &after.files),
            ("read outside its root", &before.outside, &after.outside),
        ] {
            let paths: BTreeSet<&String> = one.keys().chain(other.keys()).collect();
            for path in paths {
                let (from, to) = (one.get(path), other.get(path));
                if from != to {
                    lines.push(format!(
                        "workspace {id}: {path} {label} ({} → {})",
                        from.map_or(ABSENT, String::as_str),
                        to.map_or(ABSENT, String::as_str)
                    ));
                }
            }
        }
    }
    lines
}
