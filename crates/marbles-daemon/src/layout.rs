use std::env;
use std::ffi::OsString;
use std::io;
use std::path::{Component, Path, PathBuf};

use thiserror::Error;

const HOME_DIR: &str = ".foundry";
const STATE_DIR: &str = "marbles";
const ARTIFACTS_DIR: &str = "artifacts";
const DATABASE_FILE: &str = "marbles.db";
const SOCKET_FILE: &str = "marbles.sock";
const PROCESSES_DIR: &str = "processes";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub home: PathBuf,
    pub state: PathBuf,
    pub artifacts: PathBuf,
    pub database: PathBuf,
    pub socket: PathBuf,
    pub spawned: PathBuf,
}

#[derive(Debug, Error)]
pub enum LayoutError {
    #[error("none of FOUNDRY_ROOT, HOME or USERPROFILE is set")]
    MissingHome,
    #[error("could not read the working directory to resolve a relative Foundry home: {0}")]
    NoWorkingDirectory(#[source] io::Error),
}

impl Layout {
    pub fn resolve() -> Result<Self, LayoutError> {
        Self::resolve_home(foundry_home(
            env::var_os("FOUNDRY_ROOT"),
            env::var_os("HOME"),
            env::var_os("USERPROFILE"),
        )?)
    }

    pub fn resolve_home(home: impl Into<PathBuf>) -> Result<Self, LayoutError> {
        let home = home.into();
        let home = if home.is_absolute() {
            home
        } else {
            env::current_dir()
                .map_err(LayoutError::NoWorkingDirectory)?
                .join(home)
        };
        Ok(Self::from_home(normalize(&home)))
    }

    pub fn from_home(home: impl Into<PathBuf>) -> Self {
        let home = home.into();
        let state = home.join(STATE_DIR);

        Self {
            artifacts: home.join(ARTIFACTS_DIR),
            database: state.join(DATABASE_FILE),
            socket: state.join(SOCKET_FILE),
            spawned: home.join(PROCESSES_DIR),
            home,
            state,
        }
    }
}

fn foundry_home(
    explicit: Option<OsString>,
    home: Option<OsString>,
    user_profile: Option<OsString>,
) -> Result<PathBuf, LayoutError> {
    if let Some(explicit) = non_empty(explicit) {
        return Ok(PathBuf::from(explicit));
    }
    non_empty(home)
        .or_else(|| non_empty(user_profile))
        .map(|user_home| PathBuf::from(user_home).join(HOME_DIR))
        .ok_or(LayoutError::MissingHome)
}

fn non_empty(value: Option<OsString>) -> Option<OsString> {
    value.filter(|value| !value.is_empty())
}

pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                }
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component);
            }
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_paths_match_marbles_conventions() {
        let layout = Layout::from_home("/tmp/foundry-test");

        assert_eq!(layout.home, PathBuf::from("/tmp/foundry-test"));
        assert_eq!(layout.state, PathBuf::from("/tmp/foundry-test/marbles"));
        assert_eq!(
            layout.artifacts,
            PathBuf::from("/tmp/foundry-test/artifacts")
        );
        assert_eq!(
            layout.database,
            PathBuf::from("/tmp/foundry-test/marbles/marbles.db")
        );
        assert_eq!(
            layout.socket,
            PathBuf::from("/tmp/foundry-test/marbles/marbles.sock")
        );
        assert_eq!(layout.spawned, PathBuf::from("/tmp/foundry-test/processes"));
    }

    #[test]
    fn foundry_home_variable_wins_over_user_homes() {
        let home = foundry_home(
            Some("/opt/foundry".into()),
            Some("/Users/someone".into()),
            Some("C:\\Users\\someone".into()),
        );

        assert_eq!(home.ok(), Some(PathBuf::from("/opt/foundry")));
    }

    #[test]
    fn home_is_used_when_foundry_home_is_empty() {
        let home = foundry_home(Some("".into()), Some("/Users/someone".into()), None);

        assert_eq!(home.ok(), Some(PathBuf::from("/Users/someone/.foundry")));
    }

    #[test]
    fn user_profile_is_used_without_home() {
        let home = foundry_home(None, Some("".into()), Some("/profiles/someone".into()));

        assert_eq!(home.ok(), Some(PathBuf::from("/profiles/someone/.foundry")));
    }

    #[test]
    fn missing_homes_are_reported() {
        assert!(matches!(
            foundry_home(None, Some("".into()), None),
            Err(LayoutError::MissingHome)
        ));
    }

    #[test]
    fn an_explicit_home_is_made_absolute_and_normalised() {
        let cwd = env::current_dir().expect("the working directory");
        let relative = Layout::resolve_home("work/./repo/../home").expect("the layout");
        let absolute = Layout::resolve_home("/opt/./foundry/../home").expect("the layout");

        assert_eq!(relative.home, normalize(&cwd.join("work/home")));
        assert_eq!(absolute, Layout::from_home("/opt/home"));
    }

    #[test]
    fn paths_are_normalised_lexically() {
        assert_eq!(
            normalize(Path::new("/work/./repo/../foundry/./home/")),
            PathBuf::from("/work/foundry/home")
        );
        assert_eq!(normalize(Path::new("/../a/..")), PathBuf::from("/"));
        assert_eq!(
            normalize(&Path::new("/cwd/sub").join("../.foundry")),
            PathBuf::from("/cwd/.foundry")
        );
    }
}
