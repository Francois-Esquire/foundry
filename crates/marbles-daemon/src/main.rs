use std::env;
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::ExitCode;

use marbles_daemon::lifecycle::{self, DaemonOptions, StartError as DaemonStartError};
use marbles_daemon::{Layout, LayoutError};
use thiserror::Error;
use tokio::signal::unix::{SignalKind, signal};

#[derive(Debug, Error)]
enum StartError {
    #[error(transparent)]
    Layout(#[from] LayoutError),
    #[error(transparent)]
    Daemon(#[from] DaemonStartError),
    #[error("could not listen for stop signals: {0}")]
    Signals(#[source] io::Error),
    #[error("{0} needs a value")]
    MissingValue(&'static str),
    #[error("{0} must not be empty")]
    EmptyValue(&'static str),
    #[error("--version must be valid UTF-8")]
    UnreadableVersion,
    #[error("unknown argument {}", .0.to_string_lossy())]
    UnknownArgument(OsString),
}

#[derive(Debug, Default)]
struct Overrides {
    home: Option<PathBuf>,
    version: Option<String>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("marbles-daemon: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), StartError> {
    let overrides = parse_args(env::args_os().skip(1))?;
    let layout = match overrides.home {
        Some(home) => Layout::resolve_home(home)?,
        None => Layout::resolve()?,
    };
    let version = overrides
        .version
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
    let mut interrupt = signal(SignalKind::interrupt()).map_err(StartError::Signals)?;
    let mut terminate = signal(SignalKind::terminate()).map_err(StartError::Signals)?;
    let daemon = lifecycle::start(DaemonOptions::new(layout, version)).await?;
    tokio::select! {
        () = daemon.wait_closed() => {}
        _ = interrupt.recv() => daemon.shutdown().await,
        _ = terminate.recv() => daemon.shutdown().await,
    }
    Ok(())
}

fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Overrides, StartError> {
    let mut overrides = Overrides::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--home" {
            overrides.home = Some(PathBuf::from(value_of("--home", args.next())?));
        } else if arg == "--version" {
            let version = value_of("--version", args.next())?;
            overrides.version = Some(
                version
                    .into_string()
                    .map_err(|_| StartError::UnreadableVersion)?,
            );
        } else {
            return Err(StartError::UnknownArgument(arg));
        }
    }
    Ok(overrides)
}

fn value_of(flag: &'static str, value: Option<OsString>) -> Result<OsString, StartError> {
    match value {
        None => Err(StartError::MissingValue(flag)),
        Some(value) if value.is_empty() => Err(StartError::EmptyValue(flag)),
        Some(value) => Ok(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(args: &[&str]) -> Result<Overrides, StartError> {
        parse_args(args.iter().map(OsString::from))
    }

    #[test]
    fn no_arguments_override_nothing() {
        let overrides = parsed(&[]).expect("no arguments parse");

        assert_eq!(overrides.home, None);
        assert_eq!(overrides.version, None);
    }

    #[test]
    fn the_launcher_can_supply_home_and_version() {
        let overrides =
            parsed(&["--version", "1.2.3", "--home", "/opt/foundry"]).expect("the overrides");

        assert_eq!(overrides.home, Some(PathBuf::from("/opt/foundry")));
        assert_eq!(overrides.version.as_deref(), Some("1.2.3"));
    }

    #[test]
    fn missing_empty_and_unknown_arguments_are_refused() {
        assert!(matches!(
            parsed(&["--home"]),
            Err(StartError::MissingValue("--home"))
        ));
        assert!(matches!(
            parsed(&["--version", ""]),
            Err(StartError::EmptyValue("--version"))
        ));
        assert!(matches!(
            parsed(&["--verbose"]),
            Err(StartError::UnknownArgument(arg)) if arg == "--verbose"
        ));
    }
}
