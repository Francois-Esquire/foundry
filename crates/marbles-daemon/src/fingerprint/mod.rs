mod digests;
mod installation;
mod print;
#[cfg(test)]
mod tests;
mod tree;

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

pub use self::digests::FileDigests;
pub use self::installation::installation_digest;
pub use self::print::{Fingerprint, WorkspacePrint, differences, print_now};
pub use self::tree::TREE_LIMIT;
pub(crate) use self::tree::is_module_path;
use crate::Layout;

pub const INSTALLATION_POLL_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRegistration {
    pub id: String,
    pub root: PathBuf,
    pub config: Option<PathBuf>,
}

pub fn ignored_paths(layout: &Layout) -> HashSet<PathBuf> {
    [&layout.home, &layout.state, &layout.artifacts]
        .into_iter()
        .flat_map(|path| {
            let canonical = fs::canonicalize(path).ok();
            std::iter::once(path.clone()).chain(canonical)
        })
        .collect()
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
