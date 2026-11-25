use std::env;
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use marbles_daemon::claim::ClaimError;
use marbles_daemon::generation::{SPAWN_RECORD_ENV, StdioMode, SubprocessLauncher};
use marbles_daemon::lifecycle::{
    self, DaemonExit, DaemonOptions, StartError as DaemonStartError, SubprocessInitializer,
};
use marbles_daemon::recycle::{self, BinaryDigest, BinaryWatch, RECYCLED_FROM, RecyclePlan};
use marbles_daemon::{Layout, LayoutError};
use thiserror::Error;
use tokio::runtime;

#[cfg(unix)]
use tokio::signal::unix::{Signal, SignalKind, signal};

const EXIT_CLAIM_HELD: u8 = 75;
const GENERATIONS_LOG: &str = "generations.log";
const NO_SELF_RECYCLE: &str = "--no-self-recycle";
const GENERATION_CMD: &str = "--generation-cmd";
const GENERATION_ARG: &str = "--generation-arg";
const GENERATION_LOG: &str = "--generation-log";
const INIT_CMD: &str = "--init-cmd";
const INIT_ARG: &str = "--init-arg";
const INSTALLATION_ROOT: &str = "--installation-root";

#[derive(Debug, Error)]
enum StartError {
    #[error(transparent)]
    Layout(#[from] LayoutError),
    #[error(transparent)]
    Daemon(#[from] DaemonStartError),
    #[error("could not start the async runtime: {0}")]
    Runtime(#[source] io::Error),
    #[error("could not listen for stop signals: {0}")]
    Signals(#[source] io::Error),
    #[error("{0} needs a value")]
    MissingValue(&'static str),
    #[error("{0} must not be empty")]
    EmptyValue(&'static str),
    #[error("--version must be valid UTF-8")]
    UnreadableVersion,
    #[error("{RECYCLED_FROM} must be a 64-digit hexadecimal binary digest")]
    UnreadableDigest,
    #[error("unknown argument {}", .0.to_string_lossy())]
    UnknownArgument(OsString),
    #[error("{0} needs {1}")]
    WithoutCommand(&'static str, &'static str),
}

#[derive(Debug, Default)]
struct Overrides {
    help: bool,
    home: Option<PathBuf>,
    version: Option<String>,
    recycled_from: Option<BinaryDigest>,
    no_self_recycle: bool,
    generation_cmd: Option<OsString>,
    generation_args: Vec<OsString>,
    generation_log: Option<PathBuf>,
    init_cmd: Option<OsString>,
    init_args: Vec<OsString>,
    installation_root: Option<PathBuf>,
}

#[derive(Debug)]
enum RunOutcome {
    Stopped,
    Recycle(RecyclePlan),
}

fn main() -> ExitCode {
    match serve() {
        Ok(RunOutcome::Stopped) => ExitCode::SUCCESS,
        Ok(RunOutcome::Recycle(plan)) => recycle_into(&plan),
        Err(error) => {
            eprintln!("marbles-daemon: {error}");
            ExitCode::from(exit_code_for(&error))
        }
    }
}

fn exit_code_for(error: &StartError) -> u8 {
    match error {
        StartError::Daemon(DaemonStartError::Claim(ClaimError::AlreadyHeld { .. })) => {
            EXIT_CLAIM_HELD
        }
        _ => 1,
    }
}

fn serve() -> Result<RunOutcome, StartError> {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let overrides = parse_args(args.iter().cloned())?;
    if overrides.help {
        print_help();
        return Ok(RunOutcome::Stopped);
    }
    #[cfg(unix)]
    if overrides.recycled_from.is_some() {
        reap_leftover_children();
    }
    let binary_watch = self_recycle_watch(&overrides);
    let runtime = runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(StartError::Runtime)?;
    let exit = runtime.block_on(run(overrides, binary_watch));
    drop(runtime);
    Ok(match exit? {
        DaemonExit::Stopped => RunOutcome::Stopped,
        DaemonExit::Recycle(target) => RunOutcome::Recycle(RecyclePlan::from_target(target, args)),
    })
}

#[cfg(unix)]
fn reap_leftover_children() {
    use rustix::process::{WaitOptions, wait};

    while let Ok(Some(_)) = wait(WaitOptions::NOHANG) {}
}

#[cfg(unix)]
struct StopSignals {
    interrupt: Signal,
    terminate: Signal,
}

#[cfg(unix)]
impl StopSignals {
    fn listen() -> Result<Self, StartError> {
        Ok(Self {
            interrupt: signal(SignalKind::interrupt()).map_err(StartError::Signals)?,
            terminate: signal(SignalKind::terminate()).map_err(StartError::Signals)?,
        })
    }

    async fn received(&mut self) {
        tokio::select! {
            _ = self.interrupt.recv() => {}
            _ = self.terminate.recv() => {}
        }
    }
}

#[cfg(not(unix))]
struct StopSignals;

#[cfg(not(unix))]
impl StopSignals {
    fn listen() -> Result<Self, StartError> {
        Ok(Self)
    }

    async fn received(&mut self) {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn run(
    overrides: Overrides,
    binary_watch: Option<BinaryWatch>,
) -> Result<DaemonExit, StartError> {
    let layout = match overrides.home {
        Some(home) => Layout::resolve_home(home)?,
        None => Layout::resolve()?,
    };
    let version = overrides
        .version
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
    let mut stops = StopSignals::listen()?;
    let self_recycling = !overrides.no_self_recycle;
    let options = DaemonOptions::new(layout.clone(), version).with_database();
    let options = match binary_watch {
        Some(binary_watch) => options.with_binary_watch(binary_watch),
        None => options,
    };
    let options = match overrides.generation_cmd {
        Some(program) => {
            let stdio = match overrides.generation_log {
                Some(log) => StdioMode::LogFile(log),
                None if self_recycling => StdioMode::LogFile(layout.state.join(GENERATIONS_LOG)),
                None => StdioMode::Piped,
            };
            let launcher =
                SubprocessLauncher::new(program, overrides.generation_args).with_stdio_mode(stdio);
            let launcher = match spawn_record_dir() {
                Some(dir) => launcher.with_spawn_record_dir(dir),
                None => launcher,
            };
            options.with_launcher(launcher)
        }
        None => options,
    };
    let options = match overrides.init_cmd {
        Some(program) => options.with_initializer(SubprocessInitializer {
            program: PathBuf::from(program),
            args: overrides.init_args,
            layout,
        }),
        None => options,
    };
    let options = match overrides.installation_root {
        Some(root) => options.with_installation(root),
        None => options,
    };
    let daemon = tokio::select! {
        started = lifecycle::start(options) => started?,
        () = stops.received() => return Ok(DaemonExit::Stopped),
    };
    Ok(tokio::select! {
        exit = daemon.wait_exit() => exit,
        () = stops.received() => {
            daemon.shutdown().await;
            DaemonExit::Stopped
        }
    })
}

fn spawn_record_dir() -> Option<PathBuf> {
    env::var_os(SPAWN_RECORD_ENV)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

fn self_recycle_watch(overrides: &Overrides) -> Option<BinaryWatch> {
    if overrides.no_self_recycle {
        return None;
    }
    let watch = match BinaryWatch::capture_current() {
        Ok(watch) => watch,
        Err(error) => {
            println!(
                "[marbles] could not read the daemon binary ({error}); disabling self-recycle"
            );
            return None;
        }
    };
    if overrides.recycled_from == Some(watch.initial_digest()) {
        println!("[marbles] recycled into the same binary digest; disabling self-recycle");
        return None;
    }
    Some(watch)
}

fn recycle_into(plan: &RecyclePlan) -> ExitCode {
    let _ = io::stdout().flush();
    let error = recycle::replace_current_process(plan);
    eprintln!(
        "marbles-daemon: could not recycle into {}: {error}",
        plan.executable.display()
    );
    ExitCode::FAILURE
}

fn print_help() {
    println!(
        "marbles-daemon {}\n\nUsage: marbles-daemon [OPTIONS]\n\nOptions:\n  --home <PATH>\n  --version <VERSION>\n  --init-cmd <CMD> [--init-arg <ARG>...]\n  --generation-cmd <CMD> [--generation-arg <ARG>...] [--generation-log <PATH>]\n  --installation-root <PATH>\n  --no-self-recycle\n  -h, --help",
        env!("CARGO_PKG_VERSION")
    );
}

fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Overrides, StartError> {
    let mut overrides = Overrides::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            overrides.help = true;
            return Ok(overrides);
        } else if arg == "--home" {
            overrides.home = Some(PathBuf::from(value_of("--home", args.next())?));
        } else if arg == "--version" {
            let version = value_of("--version", args.next())?;
            overrides.version = Some(
                version
                    .into_string()
                    .map_err(|_| StartError::UnreadableVersion)?,
            );
        } else if arg == RECYCLED_FROM {
            let digest = value_of(RECYCLED_FROM, args.next())?;
            overrides.recycled_from = Some(
                digest
                    .to_str()
                    .and_then(|digest| digest.parse().ok())
                    .ok_or(StartError::UnreadableDigest)?,
            );
        } else if arg == NO_SELF_RECYCLE {
            overrides.no_self_recycle = true;
        } else if arg == GENERATION_CMD {
            overrides.generation_cmd = Some(value_of(GENERATION_CMD, args.next())?);
        } else if arg == GENERATION_ARG {
            let value = args
                .next()
                .ok_or(StartError::MissingValue(GENERATION_ARG))?;
            overrides.generation_args.push(value);
        } else if arg == GENERATION_LOG {
            overrides.generation_log = Some(PathBuf::from(value_of(GENERATION_LOG, args.next())?));
        } else if arg == INIT_CMD {
            overrides.init_cmd = Some(value_of(INIT_CMD, args.next())?);
        } else if arg == INIT_ARG {
            let value = args.next().ok_or(StartError::MissingValue(INIT_ARG))?;
            overrides.init_args.push(value);
        } else if arg == INSTALLATION_ROOT {
            overrides.installation_root =
                Some(PathBuf::from(value_of(INSTALLATION_ROOT, args.next())?));
        } else {
            return Err(StartError::UnknownArgument(arg));
        }
    }
    if overrides.generation_cmd.is_none()
        && (!overrides.generation_args.is_empty() || overrides.generation_log.is_some())
    {
        let flag = if overrides.generation_args.is_empty() {
            GENERATION_LOG
        } else {
            GENERATION_ARG
        };
        return Err(StartError::WithoutCommand(flag, GENERATION_CMD));
    }
    if overrides.init_cmd.is_none() && !overrides.init_args.is_empty() {
        return Err(StartError::WithoutCommand(INIT_ARG, INIT_CMD));
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
        assert_eq!(overrides.recycled_from, None);
        assert!(!overrides.no_self_recycle);
        assert_eq!(overrides.generation_cmd, None);
        assert!(overrides.generation_args.is_empty());
    }

    #[test]
    fn a_recycled_daemon_names_the_digest_it_recycled_from() {
        let digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

        let overrides =
            parsed(&["--home", "/opt/foundry", RECYCLED_FROM, digest]).expect("the overrides");

        assert_eq!(overrides.recycled_from, digest.parse().ok());
        assert!(matches!(
            parsed(&[RECYCLED_FROM, "abc"]),
            Err(StartError::UnreadableDigest)
        ));
        assert!(matches!(
            parsed(&[RECYCLED_FROM]),
            Err(StartError::MissingValue(RECYCLED_FROM))
        ));
    }

    #[test]
    fn help_is_requested_by_either_flag() {
        for flag in ["--help", "-h"] {
            let overrides = parsed(&[flag]).expect("the overrides");

            assert!(overrides.help);
        }
        assert!(!parsed(&[]).expect("the overrides").help);
    }

    #[test]
    fn self_recycle_can_be_switched_off() {
        let overrides = parsed(&[NO_SELF_RECYCLE]).expect("the overrides");

        assert!(overrides.no_self_recycle);
        assert!(self_recycle_watch(&overrides).is_none());
    }

    #[test]
    fn the_launcher_can_supply_home_and_version() {
        let overrides =
            parsed(&["--version", "1.2.3", "--home", "/opt/foundry"]).expect("the overrides");

        assert_eq!(overrides.home, Some(PathBuf::from("/opt/foundry")));
        assert_eq!(overrides.version.as_deref(), Some("1.2.3"));
    }

    #[test]
    fn a_wrapped_runtime_is_named_with_its_arguments() {
        let overrides = parsed(&[
            GENERATION_CMD,
            "bun",
            GENERATION_ARG,
            "/opt/marbles/dist/generation.js",
            GENERATION_ARG,
            "",
        ])
        .expect("the overrides");

        assert_eq!(overrides.generation_cmd, Some(OsString::from("bun")));
        assert_eq!(
            overrides.generation_args,
            [
                OsString::from("/opt/marbles/dist/generation.js"),
                OsString::new()
            ]
        );
        assert!(matches!(
            parsed(&[GENERATION_ARG, "x"]),
            Err(StartError::WithoutCommand(GENERATION_ARG, GENERATION_CMD))
        ));
        assert!(matches!(
            parsed(&[GENERATION_CMD, ""]),
            Err(StartError::EmptyValue(GENERATION_CMD))
        ));
    }

    #[test]
    fn an_initializer_log_and_installation_can_be_named() {
        let overrides = parsed(&[
            INIT_CMD,
            "bun",
            INIT_ARG,
            "/opt/marbles/dist/initialize.js",
            GENERATION_CMD,
            "bun",
            GENERATION_LOG,
            "/var/log/generations.log",
            INSTALLATION_ROOT,
            "/opt/marbles",
        ])
        .expect("the overrides");

        assert_eq!(overrides.init_cmd, Some(OsString::from("bun")));
        assert_eq!(
            overrides.init_args,
            [OsString::from("/opt/marbles/dist/initialize.js")]
        );
        assert_eq!(
            overrides.generation_log,
            Some(PathBuf::from("/var/log/generations.log"))
        );
        assert_eq!(
            overrides.installation_root,
            Some(PathBuf::from("/opt/marbles"))
        );
        assert!(matches!(
            parsed(&[INIT_ARG, "x"]),
            Err(StartError::WithoutCommand(INIT_ARG, INIT_CMD))
        ));
        assert!(matches!(
            parsed(&[GENERATION_LOG, "/tmp/log"]),
            Err(StartError::WithoutCommand(GENERATION_LOG, GENERATION_CMD))
        ));
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
