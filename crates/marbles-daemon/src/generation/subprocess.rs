use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::launcher::{GenerationExit, GenerationLauncher, SpawnSpec, SpawnedGeneration};
use super::output::OutputLines;
use crate::atomic_file::write_atomic;
use crate::claim::STATE_MODE;
use crate::identity::{ProcessIdentity, pid_exists, read_start};
use crate::protocol::MAX_LINE_BYTES;

pub const STDERR_TAIL: usize = 20;
pub const SPAWN_RECORD_ENV: &str = "MARBLES_SPAWN_RECORD";
pub const SPAWN_RECOVERY_ENV: &str = "MARBLES_SPAWN_RECOVERY";

const LINE_CAPACITY: usize = 256;
const READ_CHUNK_BYTES: usize = 64 * 1024;
#[cfg(unix)]
const LOG_MODE: u32 = 0o600;
#[cfg(unix)]
const RECORD_MODE: u32 = 0o600;
const READER_GRACE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum StdioMode {
    #[default]
    Piped,
    LogFile(PathBuf),
}

#[derive(Debug, Clone)]
pub struct SubprocessLauncher {
    program: OsString,
    base_args: Vec<OsString>,
    stdio: StdioMode,
    spawn_record_dir: Option<PathBuf>,
    record_reported: Arc<AtomicBool>,
}

type Tail = Arc<Mutex<VecDeque<String>>>;

impl SubprocessLauncher {
    pub fn new(
        program: impl Into<OsString>,
        base_args: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        Self {
            program: program.into(),
            base_args: base_args.into_iter().map(Into::into).collect(),
            stdio: StdioMode::Piped,
            spawn_record_dir: None,
            record_reported: Arc::default(),
        }
    }

    pub fn with_stdio_mode(self, stdio: StdioMode) -> Self {
        Self { stdio, ..self }
    }

    pub fn with_spawn_record_dir(self, dir: impl Into<PathBuf>) -> Self {
        Self {
            spawn_record_dir: Some(dir.into()),
            ..self
        }
    }

    fn record_spawned(&self, identity: &ProcessIdentity) {
        let Some(dir) = self.spawn_record_dir.as_deref() else {
            return;
        };
        let Err(error) = record_spawned_into(dir, identity) else {
            return;
        };
        if !self.record_reported.swap(true, Ordering::Relaxed) {
            eprintln!(
                "could not record process {} in {}: {error}",
                identity.pid,
                dir.display()
            );
        }
    }

    fn outputs(&self) -> io::Result<(Stdio, Stdio)> {
        match &self.stdio {
            StdioMode::Piped => Ok((Stdio::piped(), Stdio::piped())),
            StdioMode::LogFile(path) => {
                if let Some(parent) = path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                {
                    fs::create_dir_all(parent)?;
                }
                let mut options = OpenOptions::new();
                options.create(true).append(true);
                #[cfg(unix)]
                options.mode(LOG_MODE);
                let log: File = options.open(path)?;
                Ok((Stdio::from(log.try_clone()?), Stdio::from(log)))
            }
        }
    }

    fn command(&self, spec: &SpawnSpec) -> io::Result<Command> {
        let (stdout, stderr) = self.outputs()?;
        let mut command = Command::new(&self.program);
        command
            .args(&self.base_args)
            .arg("--socket")
            .arg(&spec.socket)
            .arg("--token")
            .arg(spec.token.as_str())
            .current_dir(&spec.layout.state)
            .env("FOUNDRY_HOME", &spec.layout.home)
            .env(SPAWN_RECOVERY_ENV, &spec.layout.spawned)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        #[cfg(unix)]
        command.process_group(0);
        Ok(command)
    }
}

impl GenerationLauncher for SubprocessLauncher {
    fn spawn(&self, spec: SpawnSpec) -> Result<SpawnedGeneration, io::Error> {
        let mut child = self.command(&spec)?.spawn()?;
        let pid = child.id();
        let spawned_as = pid.map(|pid| ProcessIdentity {
            pid,
            started: read_start(pid).known(),
        });
        if let Some(identity) = spawned_as.as_ref() {
            self.record_spawned(identity);
        }
        let (lines, received) = mpsc::channel(LINE_CAPACITY);
        let tail: Tail = Arc::default();
        let readers = [
            child
                .stdout
                .take()
                .map(|stdout| tokio::spawn(forward(stdout, lines.clone(), None))),
            child
                .stderr
                .take()
                .map(|stderr| tokio::spawn(forward(stderr, lines, Some(Arc::clone(&tail))))),
        ];
        let (exit, exited) = oneshot::channel();
        tokio::spawn(watch_exit(child, readers, tail, exit));
        Ok(SpawnedGeneration {
            pid,
            spawned_as,
            exited,
            lines: received,
        })
    }
}

async fn forward(
    mut stream: impl AsyncRead + Unpin,
    lines: mpsc::Sender<String>,
    tail: Option<Tail>,
) {
    let mut splitter = OutputLines::new(MAX_LINE_BYTES);
    let mut buffer = vec![0; READ_CHUNK_BYTES];
    loop {
        let read = match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => splitter.push(&buffer[..count]),
        };
        for line in read {
            emit(line, &lines, tail.as_ref()).await;
        }
    }
    if let Some(line) = splitter.finish() {
        emit(line, &lines, tail.as_ref()).await;
    }
}

async fn emit(line: String, lines: &mpsc::Sender<String>, tail: Option<&Tail>) {
    if let Some(tail) = tail {
        let mut kept = tail.lock().unwrap_or_else(PoisonError::into_inner);
        kept.push_back(line.clone());
        if kept.len() > STDERR_TAIL {
            kept.pop_front();
        }
    }
    let _ = lines.send(line).await;
}

async fn watch_exit(
    mut child: Child,
    readers: [Option<JoinHandle<()>>; 2],
    tail: Tail,
    exit: oneshot::Sender<GenerationExit>,
) {
    let status = child.wait().await;
    let mut readers: Vec<JoinHandle<()>> = readers.into_iter().flatten().collect();
    let settled = tokio::time::timeout(READER_GRACE, async {
        for reader in &mut readers {
            let _ = reader.await;
        }
    })
    .await;
    if settled.is_err() {
        for reader in &readers {
            reader.abort();
        }
    }
    let tail: Vec<String> = tail
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .cloned()
        .collect();
    let _ = exit.send(exit_of(status, &tail));
}

fn exit_of(status: io::Result<ExitStatus>, tail: &[String]) -> GenerationExit {
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            return GenerationExit {
                clean: false,
                reason: format!("its exit could not be read: {error}"),
            };
        }
    };
    let clean = status.success();
    let reason = if !clean && !tail.is_empty() {
        tail.join("\n")
    } else {
        described(status)
    };
    GenerationExit { clean, reason }
}

#[cfg(unix)]
fn described(status: ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;

    match (status.code(), status.signal()) {
        (Some(code), _) => format!("exit {code}"),
        (None, Some(signal)) => format!("exit signal {signal}"),
        (None, None) => "exit unknown".to_owned(),
    }
}

#[cfg(not(unix))]
fn described(status: ExitStatus) -> String {
    status
        .code()
        .map_or_else(|| "exit unknown".to_owned(), |code| format!("exit {code}"))
}

fn record_spawned_into(dir: &Path, identity: &ProcessIdentity) -> io::Result<()> {
    let Some(started) = identity.started.as_deref() else {
        if pid_exists(identity.pid) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "it is not listed, yet a signal reaches it",
            ));
        }
        return Ok(());
    };
    prepare_record_dir(dir)?;
    let path = dir.join(format!("{}.json", identity.pid));
    let payload = json!({
        "group": true,
        "pid": identity.pid,
        "started": started,
    })
    .to_string();
    #[cfg(unix)]
    let mode = Some(RECORD_MODE);
    #[cfg(not(unix))]
    let mode = None;
    write_atomic(&path, payload.as_bytes(), mode)
}

fn prepare_record_dir(dir: &Path) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(STATE_MODE);
    builder.create(dir)?;
    #[cfg(unix)]
    {
        let meta = fs::symlink_metadata(dir)?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "spawn record directory is not a private directory",
            ));
        }
        if meta.uid() != rustix::process::getuid().as_raw() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "spawn record directory belongs to another user",
            ));
        }
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "spawn record directory is open to group or others",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::ExitStatusExt;

    use super::super::launcher::registration_token;
    use super::*;

    #[test]
    fn a_failed_exit_explains_itself_with_the_stderr_tail() {
        let tail = vec!["first".to_owned(), "second".to_owned()];

        assert_eq!(
            exit_of(Ok(ExitStatus::from_raw(256)), &tail),
            GenerationExit {
                clean: false,
                reason: "first\nsecond".to_owned(),
            }
        );
    }

    #[test]
    fn exits_without_a_tail_name_the_code_or_signal() {
        assert_eq!(
            exit_of(Ok(ExitStatus::from_raw(0)), &["noise".to_owned()]),
            GenerationExit {
                clean: true,
                reason: "exit 0".to_owned(),
            }
        );
        assert_eq!(
            exit_of(Ok(ExitStatus::from_raw(9)), &[]).reason,
            "exit signal 9"
        );
    }

    #[tokio::test]
    async fn a_grandchild_holding_the_pipes_does_not_delay_the_exit_report() {
        let home = crate::test_support::home();
        std::fs::create_dir_all(&home.layout.state).expect("the state root");
        let launcher = SubprocessLauncher::new("/bin/sh", ["-c", "sleep 30 & exit 0"]);
        let spec = SpawnSpec {
            number: 1,
            token: registration_token().expect("a token"),
            socket: home.layout.socket.clone(),
            layout: home.layout.clone(),
        };

        let spawned = launcher.spawn(spec).expect("the shell spawns");
        let pid = spawned.pid.expect("a pid");
        let exit = tokio::time::timeout(Duration::from_secs(2), spawned.exited).await;
        let _ = std::process::Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .status();

        let exit = exit
            .expect("the exit is reported promptly")
            .expect("an exit");
        assert!(exit.clean);
    }

    #[test]
    fn spawn_records_write_private_json_for_a_recorded_generation() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let records = dir.path().join("records");
        let identity = ProcessIdentity {
            pid: 4242,
            started: Some("ps:2026-11-25T00:00:00Z".to_owned()),
        };

        record_spawned_into(&records, &identity).expect("spawn record written");

        let path = records.join("4242.json");
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("the record file"))
                .expect("valid json");
        assert_eq!(
            parsed,
            json!({
                "group": true,
                "pid": 4242,
                "started": "ps:2026-11-25T00:00:00Z",
            })
        );
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(&records)
                    .expect("record dir")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&path)
                    .expect("record file")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn a_symlinked_record_directory_is_refused() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let real = dir.path().join("real");
        fs::create_dir(&real).expect("the real directory");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).expect("the symlink");

        let error = prepare_record_dir(&link).expect_err("a symlink is refused");

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn a_record_directory_open_to_group_or_others_is_refused() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let open = dir.path().join("open");
        fs::create_dir(&open).expect("the directory");
        fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).expect("the mode");

        let error = prepare_record_dir(&open).expect_err("an open directory is refused");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn a_live_process_without_a_start_is_reported_and_a_gone_one_is_not() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let live = ProcessIdentity {
            pid: std::process::id(),
            started: None,
        };
        let gone = ProcessIdentity {
            pid: u32::MAX - 1,
            started: None,
        };

        let error = record_spawned_into(dir.path(), &live).expect_err("a live pid is reported");

        assert!(error.to_string().contains("yet a signal reaches it"));
        assert!(record_spawned_into(dir.path(), &gone).is_ok());
    }

    #[test]
    fn a_launcher_reports_a_failed_record_once() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let launcher = SubprocessLauncher::new("true", Vec::<OsString>::new())
            .with_spawn_record_dir(dir.path());
        let live = ProcessIdentity {
            pid: std::process::id(),
            started: None,
        };

        launcher.record_spawned(&live);
        launcher.record_spawned(&live);

        assert!(launcher.record_reported.load(Ordering::Relaxed));
    }
}
