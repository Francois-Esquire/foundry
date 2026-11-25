use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::{FileDigests, WorkspaceRegistration};

pub const TREE_LIMIT: usize = 20_000;
pub(crate) const MISSING: &str = "missing";

const SKIPPED: &[&str] = &[
    ".cache",
    ".git",
    ".marbles",
    ".next",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
];
const MODULE_EXTENSIONS: &[&str] = &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
const DATA_EXTENSIONS: &[&str] = &["json", "jsonc", "toml", "txt", "yaml", "yml"];
const ENV_PREFIX: &str = ".env";

pub(super) struct Tree {
    pub(super) root: PathBuf,
    pub(super) files: BTreeMap<String, String>,
}

pub(crate) fn is_module_path(path: &Path) -> bool {
    has_extension(path, MODULE_EXTENSIONS)
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extensions.contains(&extension))
}

fn importable(path: &Path) -> bool {
    is_module_path(path)
        || has_extension(path, DATA_EXTENSIONS)
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(ENV_PREFIX))
}

fn files_below(dir: &Path, limit: usize, ignored: &HashSet<PathBuf>) -> Option<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_owned()];
    while let Some(at) = pending.pop() {
        let Ok(entries) = fs::read_dir(&at) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = at.join(entry.file_name());
            let skipped = entry
                .file_name()
                .to_str()
                .is_some_and(|name| SKIPPED.contains(&name));
            if skipped || ignored.contains(&path) {
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push(path),
                Ok(kind) if kind.is_file() && importable(&path) => files.push(path),
                _ => {}
            }
        }
        if files.len() > limit {
            return None;
        }
    }
    files.sort();
    Some(files)
}

pub(super) fn tree_files(
    registration: &WorkspaceRegistration,
    digests: &mut FileDigests,
    ignored: &HashSet<PathBuf>,
    limit: usize,
) -> Tree {
    let mut root = registration.root.clone();
    let mut files = files_below(&root, limit, ignored);
    let fallback = registration.config.as_deref().and_then(Path::parent);
    if let (None, Some(parent)) = (&files, fallback) {
        root = parent.to_owned();
        files = files_below(&root, limit, ignored);
    }
    let files = files
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| {
            let relative = file.strip_prefix(&root).ok()?.display().to_string();
            let digest = digests.of(&file).unwrap_or_else(|| MISSING.to_owned());
            Some((relative, digest))
        })
        .collect();
    Tree { root, files }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, relative: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("the parent");
        }
        fs::write(path, relative).expect("the file");
    }

    fn registration(root: &Path, config: Option<PathBuf>) -> WorkspaceRegistration {
        WorkspaceRegistration {
            id: "w1".to_owned(),
            root: root.to_owned(),
            config,
        }
    }

    fn listed(tree: &Tree) -> Vec<&str> {
        tree.files.keys().map(String::as_str).collect()
    }

    #[test]
    fn the_tree_holds_importable_files_outside_skipped_and_ignored_directories() {
        let dir = tempfile::tempdir().expect("a directory");
        let root = dir.path();
        for file in [
            "a.ts",
            "b.tsx",
            "c.mjs",
            "d.cjs",
            "data/e.json",
            "data/f.yaml",
            "g.toml",
            "notes.txt",
            ".env",
            ".env.local",
            "README.md",
            "image.png",
            "node_modules/pkg/index.js",
            ".git/config.json",
            "dist/out.js",
            ".marbles/link.json",
            "ignored/inner.ts",
            "nested/deep/h.mts",
        ] {
            write(root, file);
        }
        let ignored = HashSet::from([root.join("ignored")]);
        let mut digests = FileDigests::default();

        let tree = tree_files(
            &registration(root, None),
            &mut digests,
            &ignored,
            TREE_LIMIT,
        );

        assert_eq!(tree.root, root);
        assert_eq!(
            listed(&tree),
            [
                ".env",
                ".env.local",
                "a.ts",
                "b.tsx",
                "c.mjs",
                "d.cjs",
                "data/e.json",
                "data/f.yaml",
                "g.toml",
                "nested/deep/h.mts",
                "notes.txt",
            ]
        );
        assert_eq!(
            tree.files.get("a.ts"),
            digests.of(&root.join("a.ts")).as_ref()
        );
    }

    #[test]
    fn a_tree_over_the_limit_falls_back_to_the_directory_of_its_config() {
        let dir = tempfile::tempdir().expect("a directory");
        let root = dir.path();
        for file in ["one.ts", "two.ts", "three.ts", "src/marbles/flow.ts"] {
            write(root, file);
        }
        let config = root.join("src/marbles/index.ts");
        let mut digests = FileDigests::default();

        let fallen_back = tree_files(
            &registration(root, Some(config)),
            &mut digests,
            &HashSet::new(),
            2,
        );
        let unconfigured = tree_files(&registration(root, None), &mut digests, &HashSet::new(), 2);

        assert_eq!(fallen_back.root, root.join("src/marbles"));
        assert_eq!(listed(&fallen_back), ["flow.ts"]);
        assert_eq!(unconfigured.root, root);
        assert!(unconfigured.files.is_empty());
    }

    #[test]
    fn symlinked_directories_are_not_followed() {
        let dir = tempfile::tempdir().expect("a directory");
        let outside = tempfile::tempdir().expect("an outside directory");
        write(outside.path(), "far.ts");
        write(dir.path(), "near.ts");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).expect("the link");
        let mut digests = FileDigests::default();

        let tree = tree_files(
            &registration(dir.path(), None),
            &mut digests,
            &HashSet::new(),
            TREE_LIMIT,
        );

        assert_eq!(listed(&tree), ["near.ts"]);
    }
}
