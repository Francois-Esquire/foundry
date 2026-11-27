mod recycle {
    use std::fs::{self, Permissions};
    use std::io::{BufRead, BufReader, Lines, Write};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use marbles_daemon::channel::{self, ChannelEvent};
    use marbles_daemon::identity::{pid_exists, this_process};
    use marbles_daemon::protocol::{DaemonMethod, GenerationMethod, Response, WireError};
    use marbles_daemon::recycle::{BinaryDigest, RECYCLED_FROM};
    use serde_json::{Value, json};

    const PATIENCE: Duration = Duration::from_secs(20);
    const CHILD: &str = "recycle::generation_child";
    const TICKS: usize = 20;
    const TICK: Duration = Duration::from_millis(25);
    const SUCCESSOR: &[u8] = b"#!/bin/sh\nprintf 'successor %s\\n' \"$$\"\nprintf 'program %s\\n' \"$0\"\nfor arg in \"$@\"; do printf 'arg %s\\n' \"$arg\"; done\n";

    struct Daemon(Child);

    impl Drop for Daemon {
        fn drop(&mut self) {
            if matches!(self.0.try_wait(), Ok(None)) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    impl Daemon {
        fn exit_within(&mut self, patience: Duration) -> ExitStatus {
            let deadline = Instant::now() + patience;
            loop {
                if let Some(status) = self.0.try_wait().expect("the daemon's status") {
                    return status;
                }
                assert!(Instant::now() < deadline, "the daemon should exit");
                thread::sleep(Duration::from_millis(20));
            }
        }
    }

    struct Install {
        home: tempfile::TempDir,
        _bin: tempfile::TempDir,
        executable: PathBuf,
    }

    impl Install {
        fn new() -> Self {
            let home = tempfile::Builder::new()
                .prefix("md")
                .tempdir_in("/tmp")
                .expect("a temporary home");
            let bin = tempfile::tempdir().expect("a temporary install");
            let executable = bin.path().join("marbles-daemon");
            fs::copy(env!("CARGO_BIN_EXE_marbles-daemon"), &executable).expect("the daemon copy");
            fs::set_permissions(&executable, Permissions::from_mode(0o755)).expect("the mode");
            Self {
                home,
                _bin: bin,
                executable,
            }
        }

        fn state(&self) -> PathBuf {
            self.home.path().join("marbles")
        }

        fn socket(&self) -> PathBuf {
            self.state().join("marbles.sock")
        }

        fn digest(&self) -> BinaryDigest {
            BinaryDigest::hash_file(&self.executable).expect("the daemon digest")
        }

        fn spawn(&self, extra: &[&str]) -> (Daemon, Lines<BufReader<ChildStdout>>) {
            self.spawn_through(&self.executable, extra)
        }

        fn spawn_through(
            &self,
            program: &Path,
            extra: &[&str],
        ) -> (Daemon, Lines<BufReader<ChildStdout>>) {
            let mut daemon = Daemon(
                Command::new(program)
                    .arg("--home")
                    .arg(self.home.path())
                    .args(extra)
                    .stdout(Stdio::piped())
                    .spawn()
                    .expect("the daemon should spawn"),
            );
            let printed =
                BufReader::new(daemon.0.stdout.take().expect("the daemon's stdout")).lines();
            (daemon, printed)
        }

        fn replace_with(&self, bytes: &[u8]) {
            let staged = self.executable.with_extension("staged");
            fs::write(&staged, bytes).expect("the staged successor");
            fs::set_permissions(&staged, Permissions::from_mode(0o755)).expect("the mode");
            fs::rename(&staged, &self.executable).expect("the installed successor");
        }

        fn assert_released(&self) {
            assert!(!self.socket().exists(), "the socket should be removed");
            assert!(!self.state().join("locks").join("process").exists());
            assert!(!self.state().join("process.json").exists());
        }
    }

    fn next_line(lines: &mut Lines<BufReader<ChildStdout>>) -> String {
        lines
            .next()
            .expect("the daemon should print")
            .expect("readable output")
    }

    fn digest_of(bytes: &[u8]) -> BinaryDigest {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("bytes");
        fs::write(&path, bytes).expect("the bytes");
        BinaryDigest::hash_file(&path).expect("the digest")
    }

    fn pid_line(pid: u32, socket: &Path) -> String {
        format!("[marbles] pid {pid} · {}", socket.display())
    }

    fn memory_line(install: &Install) -> String {
        format!(
            "[marbles] no state database at {} yet; using in-memory state store",
            install.state().join("marbles.db").display()
        )
    }

    #[test]
    fn a_replaced_binary_is_exec_ed_in_place_with_the_recycled_from_digest() {
        let install = Install::new();
        let previous = install.digest();
        let (mut daemon, mut printed) = install.spawn(&[]);
        let pid = daemon.0.id();
        assert_eq!(next_line(&mut printed), pid_line(pid, &install.socket()));
        assert_eq!(next_line(&mut printed), memory_line(&install));

        install.replace_with(SUCCESSOR);

        assert_eq!(
            next_line(&mut printed),
            format!(
                "[marbles] binary changed ({} -> {}); recycling",
                previous.short_hex(),
                digest_of(SUCCESSOR).short_hex()
            )
        );
        assert_eq!(next_line(&mut printed), format!("successor {pid}"));
        assert_eq!(
            next_line(&mut printed),
            format!("program {}", install.executable.display())
        );
        let home = install.home.path().display().to_string();
        let previous = previous.to_string();
        let args: Vec<String> = printed.by_ref().map_while(Result::ok).collect();
        assert_eq!(
            args,
            [
                "arg --home".to_owned(),
                format!("arg {home}"),
                format!("arg {RECYCLED_FROM}"),
                format!("arg {previous}"),
            ]
        );
        assert!(daemon.exit_within(PATIENCE).success());
        install.assert_released();
    }

    #[test]
    fn a_repointed_launch_symlink_is_exec_ed_through_the_symlink() {
        let install = Install::new();
        let launcher = install.executable.with_file_name("launcher");
        symlink(&install.executable, &launcher).expect("the launch symlink");
        let successor = install.executable.with_file_name("successor");
        fs::write(&successor, SUCCESSOR).expect("the successor");
        fs::set_permissions(&successor, Permissions::from_mode(0o755)).expect("the mode");
        let (mut daemon, mut printed) = install.spawn_through(&launcher, &[]);
        let pid = daemon.0.id();
        assert_eq!(next_line(&mut printed), pid_line(pid, &install.socket()));
        assert_eq!(next_line(&mut printed), memory_line(&install));

        let staged = launcher.with_extension("staged");
        symlink(&successor, &staged).expect("the repointed symlink");
        fs::rename(&staged, &launcher).expect("the repoint");

        assert!(next_line(&mut printed).ends_with("; recycling"));
        assert_eq!(next_line(&mut printed), format!("successor {pid}"));
        assert_eq!(
            next_line(&mut printed),
            format!("program {}", launcher.display())
        );
        assert!(daemon.exit_within(PATIENCE).success());
        assert!(install.executable.exists(), "the old binary is untouched");
        install.assert_released();
    }

    #[test]
    fn recycling_into_the_same_digest_disables_self_recycle() {
        let install = Install::new();
        let current = install.digest().to_string();
        let (mut daemon, mut printed) = install.spawn(&[RECYCLED_FROM, &current]);
        let pid = daemon.0.id();

        assert_eq!(
            next_line(&mut printed),
            "[marbles] recycled into the same binary digest; disabling self-recycle"
        );
        assert_eq!(next_line(&mut printed), pid_line(pid, &install.socket()));
        assert_eq!(next_line(&mut printed), memory_line(&install));
        let mut client = UnixStream::connect(install.socket()).expect("a connection");
        client
            .write_all(b"{\"id\":0,\"method\":\"shutdown\"}\n")
            .expect("the shutdown request");
        assert!(daemon.exit_within(PATIENCE).success());
        assert_eq!(next_line(&mut printed), "[marbles] stopping");
        install.assert_released();
    }

    struct Generation {
        root: String,
        socket: PathBuf,
        token: String,
    }

    fn generation_args() -> Option<Generation> {
        let args: Vec<String> = std::env::args().collect();
        let after = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .and_then(|at| args.get(at + 1))
                .cloned()
        };
        let root = args
            .iter()
            .find_map(|arg| arg.strip_prefix("--root=").map(str::to_owned))?;
        Some(Generation {
            root,
            socket: PathBuf::from(after("--socket")?),
            token: after("--token")?,
        })
    }

    #[test]
    fn generation_child() {
        let Some(generation) = generation_args() else {
            return;
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("the generation's runtime");
        runtime
            .block_on(async { tokio::time::timeout(PATIENCE, serve(generation)).await })
            .expect("the generation should finish in time");
    }

    async fn serve(generation: Generation) {
        println!("generation {}", std::process::id());
        let stream = tokio::net::UnixStream::connect(&generation.socket)
            .await
            .expect("the daemon socket");
        let (channel, mut events) = channel::open(stream);
        channel
            .request(
                DaemonMethod::Register,
                Some(json!({ "token": generation.token })),
            )
            .await
            .expect("the registration");
        let loads = json!([{ "root": generation.root }]);
        while let Some(ChannelEvent::Request(request)) = events.recv().await {
            let answer = match request.method.as_str().parse::<GenerationMethod>() {
                Ok(GenerationMethod::Load) => Response::ok(
                    request.id,
                    json!({ "identity": this_process(), "loads": loads }),
                ),
                Ok(GenerationMethod::Start) => {
                    println!("started");
                    Response::ok(request.id, json!({ "loads": loads }))
                }
                _ => Response::err(request.id, WireError::new("not in this test")),
            };
            let _ = channel.respond(answer);
        }
        println!("orphaned");
        for tick in 0..TICKS {
            println!("tick {tick}");
            eprintln!("tock {tick}");
            tokio::time::sleep(TICK).await;
        }
        println!("done");
    }

    fn read_log(log: &Path) -> String {
        fs::read_to_string(log).unwrap_or_default()
    }

    fn log_eventually(log: &Path, wanted: &str) -> String {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let written = read_log(log);
            if written.lines().any(|line| line == wanted) {
                return written;
            }
            assert!(
                Instant::now() < deadline,
                "the log should say {wanted:?}, but says {written:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn attach(socket: &Path, source: &Path) -> Value {
        let mut client = UnixStream::connect(socket).expect("a connection");
        client
            .set_read_timeout(Some(PATIENCE))
            .expect("a read timeout");
        let request = json!({ "id": 1, "method": "attach", "params": { "source": source } });
        writeln!(client, "{request}").expect("the attach request");
        let mut answer = String::new();
        BufReader::new(client)
            .read_line(&mut answer)
            .expect("the attach answer");
        serde_json::from_str(&answer).expect("a JSON answer")
    }

    #[test]
    fn a_generation_logging_to_a_file_outlives_a_recycle_and_finishes_cleanly() {
        let install = Install::new();
        let log = install.home.path().join("generations.log");
        outlives_a_recycle(&install, &log, true);
    }

    #[test]
    fn a_generation_with_the_default_log_outlives_a_recycle_without_a_broken_pipe() {
        let install = Install::new();
        let log = install.state().join("generations.log");
        outlives_a_recycle(&install, &log, false);
    }

    fn outlives_a_recycle(install: &Install, log: &Path, explicit_log: bool) {
        let repo = tempfile::tempdir().expect("a workspace");
        let root = fs::canonicalize(repo.path()).expect("the root");
        let source = root.join(".foundry/marbles");
        fs::create_dir_all(&source).expect("the authoring folder");
        let program = std::env::current_exe().expect("the test binary");
        let program = program.display().to_string();
        let root_arg = format!("--root={}", root.display());
        let log_arg = log.display().to_string();
        let mut extra = vec!["--generation-cmd", program.as_str()];
        for arg in [
            CHILD,
            "--exact",
            "--nocapture",
            "--test-threads=1",
            "--",
            &root_arg,
        ] {
            extra.extend(["--generation-arg", arg]);
        }
        if explicit_log {
            extra.extend(["--generation-log", log_arg.as_str()]);
        }
        let (mut daemon, mut printed) = install.spawn(&extra);
        let pid = daemon.0.id();
        assert_eq!(next_line(&mut printed), pid_line(pid, &install.socket()));
        assert_eq!(next_line(&mut printed), memory_line(install));

        let attached = attach(&install.socket(), &source);
        assert_eq!(
            attached["result"]["state"],
            json!("ready"),
            "{attached} {}",
            read_log(log)
        );
        let generation = attached["result"]["pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .expect("the generation's pid");
        log_eventually(log, "started");

        install.replace_with(SUCCESSOR);

        while !next_line(&mut printed).ends_with("; recycling") {}
        assert_eq!(next_line(&mut printed), format!("successor {pid}"));
        assert!(daemon.exit_within(PATIENCE).success());
        let written = log_eventually(log, "done");
        let deadline = Instant::now() + PATIENCE;
        while pid_exists(generation) {
            assert!(Instant::now() < deadline, "the generation should exit");
            thread::sleep(Duration::from_millis(20));
        }
        let lines: Vec<&str> = written.lines().collect();
        let orphaned = lines
            .iter()
            .position(|line| *line == "orphaned")
            .expect("the generation saw the daemon go");
        assert!(lines.contains(&format!("tick {}", TICKS - 1).as_str()));
        assert!(lines.contains(&format!("tock {}", TICKS - 1).as_str()));
        assert!(orphaned < lines.len() - 1);
        assert!(!written.contains("panicked"), "{written}");
        let announced = format!("generation {generation}");
        assert!(
            lines.iter().any(|line| line.ends_with(&announced)),
            "{written}"
        );
    }
}
