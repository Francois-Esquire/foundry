use std::error::Error;
use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;

use thiserror::Error;
use tokio::process::Command;

use crate::Layout;

pub type Initialization<'a> = Pin<Box<dyn Future<Output = Result<(), InitError>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitializeTrigger {
    Start,
    ProcessChange,
}

#[derive(Debug, Error)]
#[error("{0}")]
pub struct InitError(Box<dyn Error + Send + Sync>);

impl InitError {
    pub fn new(error: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        Self(error.into())
    }
}

pub trait Initializer: Send + Sync + 'static {
    fn initialize(&self, trigger: InitializeTrigger) -> Initialization<'_>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoopInitializer;

impl Initializer for NoopInitializer {
    fn initialize(&self, _trigger: InitializeTrigger) -> Initialization<'_> {
        Box::pin(async { Ok(()) })
    }
}

pub const INITIALIZE_TRIGGER_ENV: &str = "MARBLES_INITIALIZE_TRIGGER";

impl InitializeTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::ProcessChange => "process_change",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubprocessInitializer {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub layout: Layout,
}

impl Initializer for SubprocessInitializer {
    fn initialize(&self, trigger: InitializeTrigger) -> Initialization<'_> {
        Box::pin(async move {
            let ran = Command::new(&self.program)
                .args(&self.args)
                .env("FOUNDRY_ROOT", &self.layout.home)
                .env(INITIALIZE_TRIGGER_ENV, trigger.as_str())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .output()
                .await
                .map_err(|error| {
                    InitError::new(format!("{} did not run: {error}", self.program.display()))
                })?;
            if ran.status.success() {
                return Ok(());
            }
            let said = String::from_utf8_lossy(&ran.stderr).trim().to_owned();
            let said = if said.is_empty() {
                String::from_utf8_lossy(&ran.stdout).trim().to_owned()
            } else {
                said
            };
            let status = ran
                .status
                .code()
                .map_or_else(|| "a signal".to_owned(), |code| format!("exit {code}"));
            Err(InitError::new(if said.is_empty() {
                format!("{} failed with {status}", self.program.display())
            } else {
                format!("{} failed with {status}: {said}", self.program.display())
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> SubprocessInitializer {
        SubprocessInitializer {
            program: PathBuf::from("/bin/sh"),
            args: vec![OsString::from("-c"), OsString::from(script)],
            layout: Layout::from_home("/opt/foundry"),
        }
    }

    #[tokio::test]
    async fn the_command_runs_with_the_home_and_what_triggered_it() {
        let checked = shell(
            "test \"$FOUNDRY_ROOT\" = /opt/foundry && test \"$MARBLES_INITIALIZE_TRIGGER\" = \"$0\"",
        );
        let start = SubprocessInitializer {
            args: [checked.args.clone(), vec![OsString::from("start")]].concat(),
            ..checked.clone()
        };
        let change = SubprocessInitializer {
            args: [checked.args.clone(), vec![OsString::from("process_change")]].concat(),
            ..checked
        };

        assert!(start.initialize(InitializeTrigger::Start).await.is_ok());
        assert!(
            change
                .initialize(InitializeTrigger::ProcessChange)
                .await
                .is_ok()
        );
        assert!(
            start
                .initialize(InitializeTrigger::ProcessChange)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_failed_command_explains_itself_with_its_stderr() {
        let failing = shell("echo progress; echo 'the schema is newer' >&2; exit 3");

        let error = failing
            .initialize(InitializeTrigger::Start)
            .await
            .expect_err("the command fails");

        assert_eq!(
            error.to_string(),
            "/bin/sh failed with exit 3: the schema is newer"
        );
        let missing = SubprocessInitializer {
            program: PathBuf::from("/nonexistent/initialize"),
            ..failing
        };
        let error = missing
            .initialize(InitializeTrigger::Start)
            .await
            .expect_err("the command is missing");
        assert!(
            error
                .to_string()
                .starts_with("/nonexistent/initialize did not run: ")
        );
    }
}
