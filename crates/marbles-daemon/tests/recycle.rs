mod recycle {
    use std::fs::{self, Permissions};
    use std::io::{BufRead, BufReader, Lines, Write};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use marbles_daemon::recycle::{BinaryDigest, RECYCLED_FROM};

    const PATIENCE: Duration = Duration::from_secs(20);
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

    #[test]
    fn a_replaced_binary_is_exec_ed_in_place_with_the_recycled_from_digest() {
        let install = Install::new();
        let previous = install.digest();
        let (mut daemon, mut printed) = install.spawn(&[]);
        let pid = daemon.0.id();
        assert_eq!(next_line(&mut printed), pid_line(pid, &install.socket()));

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
        let mut client = UnixStream::connect(install.socket()).expect("a connection");
        client
            .write_all(b"{\"id\":0,\"method\":\"shutdown\"}\n")
            .expect("the shutdown request");
        assert!(daemon.exit_within(PATIENCE).success());
        assert_eq!(next_line(&mut printed), "[marbles] stopping");
        install.assert_released();
    }
}
