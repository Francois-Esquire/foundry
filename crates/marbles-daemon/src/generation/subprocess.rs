use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::launcher::{GenerationExit, GenerationLauncher, SpawnSpec, SpawnedGeneration};
use super::output::OutputLines;
use crate::identity::{ProcessIdentity, read_start};
use crate::protocol::MAX_LINE_BYTES;

pub const STDERR_TAIL: usize = 20;
pub const SPAWN_RECOVERY_ENV: &str = "MARBLES_SPAWN_RECOVERY";

const LINE_CAPACITY: usize = 256;
const READ_CHUNK_BYTES: usize = 64 * 1024;
#[cfg(unix)]
const LOG_MODE: u32 = 0o600;
const READER_GRACE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum StdioMode {
    #[default]
    Piped,
    LogFile(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubprocessLauncher {
    program: OsString,
    base_args: Vec<OsString>,
    stdio: StdioMode,
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
        }
    }

    pub fn with_stdio_mode(self, stdio: StdioMode) -> Self {
        Self { stdio, ..self }
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
}
