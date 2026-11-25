use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use super::hex;
use super::tree::MISSING;

const NODE_MODULES: &str = "node_modules";

pub fn installation_digest(root: Option<&Path>, version: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(version);
    for file in root.map(installation_files).unwrap_or_default() {
        hash.update(format!("\0{}\0{}", file.display(), stamp(&file)));
    }
    hex(&hash.finalize())
}

fn stamp(file: &Path) -> String {
    let Ok(stat) = fs::metadata(file) else {
        return MISSING.to_owned();
    };
    let modified = stat
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_millis());
    format!("{}:{modified}", stat.len())
}

fn installation_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_owned()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let hidden = name
                .to_str()
                .is_none_or(|name| name.starts_with('.') || name == NODE_MODULES);
            if hidden {
                continue;
            }
            let path = dir.join(name);
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push(path),
                Ok(kind) if kind.is_file() => files.push(path),
                _ => {}
            }
        }
    }
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::time::Duration;

    use super::*;

    fn write(root: &Path, relative: &str, bytes: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("the parent");
        }
        fs::write(&path, bytes).expect("the file");
        File::options()
            .write(true)
            .open(&path)
            .expect("the file")
            .set_modified(UNIX_EPOCH + Duration::from_secs(1_000))
            .expect("the modification time");
    }

    #[test]
    fn the_installation_changes_with_its_version_and_its_visible_files() {
        let dir = tempfile::tempdir().expect("an installation");
        let root = dir.path();
        write(root, "dist/cli.js", "one");
        let first = installation_digest(Some(root), "1.0.0");

        assert_eq!(installation_digest(Some(root), "1.0.0"), first);
        assert_ne!(installation_digest(Some(root), "1.0.1"), first);

        write(root, ".cache/noise", "x");
        write(root, "node_modules/pkg/index.js", "x");
        assert_eq!(installation_digest(Some(root), "1.0.0"), first);

        write(root, "dist/cli.js", "two!");
        let resized = installation_digest(Some(root), "1.0.0");
        assert_ne!(resized, first);

        write(root, "dist/extra.js", "x");
        assert_ne!(installation_digest(Some(root), "1.0.0"), resized);
    }

    #[test]
    fn without_an_installation_only_the_version_counts() {
        assert_eq!(
            installation_digest(None, "1.0.0"),
            hex(&Sha256::digest("1.0.0"))
        );
    }
}
