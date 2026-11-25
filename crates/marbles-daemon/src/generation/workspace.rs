use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::layout::normalize;

const ID_HEX_DIGITS: usize = 12;
const AUTHORING_DIR: &str = "marbles";
const AUTHORING_PARENT: &str = ".foundry";
const MODULE_EXTENSIONS: &[&str] = &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Placement {
    pub(super) id: String,
    pub(super) root: String,
    pub(super) config: Option<String>,
    pub(super) source: String,
}

pub(super) fn locate(source: &str, root: Option<&str>) -> Result<Placement, String> {
    let given = Path::new(source);
    if !given.is_absolute() {
        return Err(format!(
            "the source to attach must be absolute, not \"{source}\""
        ));
    }
    let config_path = normalize(given);
    let found = config_path.exists();
    let placed = if found {
        source_root(&config_path)
    } else {
        let directory = config_path.parent().unwrap_or(&config_path);
        root.map(|root| normalize(&directory.join(root)))
            .ok_or_else(|| {
                format!(
                    "nothing is at {}, and no workspace root was given to register instead",
                    config_path.display()
                )
            })?
    };
    let canonical = fs::canonicalize(&placed).map_err(|error| {
        format!(
            "the workspace root {} could not be resolved: {error}",
            placed.display()
        )
    })?;
    let root = canonical.display().to_string();
    let source = config_path.display().to_string();
    Ok(Placement {
        id: workspace_id(&root),
        config: found.then(|| source.clone()),
        root,
        source,
    })
}

pub(super) fn workspace_id(canonical_root: &str) -> String {
    let digest = Sha256::digest(canonical_root.as_bytes());
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()[..ID_HEX_DIGITS]
        .to_owned()
}

fn source_root(path: &Path) -> PathBuf {
    let is_directory = path.is_dir();
    let containing = path.parent().unwrap_or(path);
    let directory = if is_directory || !is_module_path(path) {
        path
    } else {
        containing
    };
    let authoring = directory.ancestors().find(|ancestor| {
        ancestor
            .file_name()
            .is_some_and(|name| name == AUTHORING_DIR)
            && ancestor
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == AUTHORING_PARENT)
    });
    match authoring.and_then(Path::parent).and_then(Path::parent) {
        Some(root) => root.to_owned(),
        None if is_directory => path.to_owned(),
        None => containing.to_owned(),
    }
}

fn is_module_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| MODULE_EXTENSIONS.contains(&extension))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let root = fs::canonicalize(dir.path()).expect("the canonical root");
        fs::create_dir_all(root.join(".foundry/marbles/flows")).expect("the authoring folder");
        fs::write(root.join(".foundry/marbles/flows/build.ts"), "").expect("a module");
        fs::write(root.join("marbles.config.ts"), "").expect("a config");
        (dir, root)
    }

    #[test]
    fn workspace_ids_are_the_first_twelve_hex_digits_of_the_root_digest() {
        assert_eq!(workspace_id("/repo"), "816fc349d3fa");
    }

    #[test]
    fn an_authoring_folder_places_the_workspace_above_dot_foundry() {
        let (_dir, root) = tree();
        let source = root.join(".foundry/marbles");

        let placement = locate(&source.display().to_string(), None).expect("a placement");

        assert_eq!(placement.root, root.display().to_string());
        assert_eq!(placement.id, workspace_id(&placement.root));
        assert_eq!(placement.config, Some(source.display().to_string()));
        assert_eq!(
            source_root(&root.join(".foundry/marbles/flows/build.ts")),
            root
        );
    }

    #[test]
    fn a_config_file_places_the_workspace_beside_it() {
        let (_dir, root) = tree();

        assert_eq!(source_root(&root.join("marbles.config.ts")), root);
    }

    #[test]
    fn a_missing_source_needs_a_root() {
        let (_dir, root) = tree();
        let missing = root.join("absent/marbles.config.ts").display().to_string();

        assert!(locate(&missing, None).is_err_and(|error| error.starts_with("nothing is at ")));
        let placement = locate(&missing, Some("..")).expect("a placement");
        assert_eq!(placement.root, root.display().to_string());
        assert_eq!(placement.config, None);
        assert_eq!(placement.source, missing);
    }

    #[test]
    fn a_relative_source_is_refused() {
        assert_eq!(
            locate("./repo", None),
            Err("the source to attach must be absolute, not \"./repo\"".to_owned())
        );
    }
}
