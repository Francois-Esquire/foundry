use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::hex;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Known {
    hash: String,
    size: u64,
    modified: Option<SystemTime>,
}

#[derive(Debug, Default)]
pub struct FileDigests {
    known: HashMap<PathBuf, Known>,
}

impl FileDigests {
    pub fn of(&mut self, file: &Path) -> Option<String> {
        let Ok(stat) = fs::metadata(file) else {
            self.known.remove(file);
            return None;
        };
        let size = stat.len();
        let modified = stat.modified().ok();
        let cached = self
            .known
            .get(file)
            .filter(|known| known.size == size && known.modified == modified);
        if let Some(known) = cached {
            return Some(known.hash.clone());
        }
        let hash = hex(&Sha256::digest(fs::read(file).ok()?));
        self.known.insert(
            file.to_owned(),
            Known {
                hash: hash.clone(),
                size,
                modified,
            },
        );
        Some(hash)
    }

    pub fn modified_ms(file: &Path) -> Option<u64> {
        let modified = fs::metadata(file).ok()?.modified().ok()?;
        let since = modified.duration_since(UNIX_EPOCH).ok()?;
        u64::try_from(since.as_millis()).ok()
    }

    pub fn len(&self) -> usize {
        self.known.len()
    }

    pub fn is_empty(&self) -> bool {
        self.known.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::time::Duration;

    use super::*;

    fn stamp(file: &Path, at: SystemTime) {
        File::options()
            .write(true)
            .open(file)
            .expect("the file")
            .set_modified(at)
            .expect("the modification time");
    }

    #[test]
    fn a_digest_is_kept_until_the_size_or_modification_time_changes() {
        let dir = tempfile::tempdir().expect("a directory");
        let file = dir.path().join("a.ts");
        let at = UNIX_EPOCH + Duration::from_secs(1_000_000);
        fs::write(&file, "one").expect("the file");
        stamp(&file, at);
        let mut digests = FileDigests::default();
        let first = digests.of(&file).expect("a digest");

        fs::write(&file, "two").expect("same size, new content");
        stamp(&file, at);
        assert_eq!(digests.of(&file), Some(first.clone()));

        stamp(&file, at + Duration::from_secs(1));
        let touched = digests.of(&file).expect("a digest");
        assert_ne!(touched, first);

        fs::write(&file, "three!").expect("a new size");
        stamp(&file, at + Duration::from_secs(1));
        assert_ne!(digests.of(&file), Some(touched));
    }

    #[test]
    fn a_missing_file_has_no_digest_and_is_forgotten() {
        let dir = tempfile::tempdir().expect("a directory");
        let file = dir.path().join("a.ts");
        fs::write(&file, "one").expect("the file");
        let mut digests = FileDigests::default();
        assert!(digests.of(&file).is_some());
        assert_eq!(digests.len(), 1);

        fs::remove_file(&file).expect("the removal");

        assert_eq!(digests.of(&file), None);
        assert!(digests.is_empty());
        assert_eq!(FileDigests::modified_ms(&file), None);
    }

    #[test]
    fn modification_times_are_read_in_milliseconds() {
        let dir = tempfile::tempdir().expect("a directory");
        let file = dir.path().join("a.ts");
        fs::write(&file, "one").expect("the file");
        stamp(&file, UNIX_EPOCH + Duration::from_millis(1_234_567));

        assert_eq!(FileDigests::modified_ms(&file), Some(1_234_567));
    }
}
