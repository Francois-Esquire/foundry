mod exit_codes {
    use std::io::{BufRead, BufReader};
    use std::path::Path;
    use std::process::{Child, Command, ExitStatus, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use rustix::process::{Pid, Signal, kill_process};

    const PATIENCE: Duration = Duration::from_secs(20);
    const CLAIM_HELD: i32 = 75;

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

        fn terminate(&self) {
            let pid = Pid::from_raw(self.0.id() as i32).expect("a daemon pid");
            kill_process(pid, Signal::TERM).expect("the signal");
        }
    }

    fn home() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("md")
            .tempdir_in("/tmp")
            .expect("a temporary home")
    }

    fn daemon(home: &Path, extra: &[&str]) -> Daemon {
        Daemon(
            Command::new(env!("CARGO_BIN_EXE_marbles-daemon"))
                .arg("--home")
                .arg(home)
                .args(["--version", "0.0.0", "--no-self-recycle"])
                .args(extra)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("the daemon should spawn"),
        )
    }

    fn wait_for(path: &Path) {
        let deadline = Instant::now() + PATIENCE;
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "{} should appear",
                path.display()
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_held_claim_exits_with_the_dedicated_code() {
        let home = home();
        let mut first = daemon(home.path(), &[]);
        let mut printed = BufReader::new(first.0.stdout.take().expect("the daemon's stdout"));
        let mut line = String::new();
        printed.read_line(&mut line).expect("the first line");
        assert!(line.starts_with("[marbles] pid "), "{line}");

        let mut second = daemon(home.path(), &[]);
        let status = second.exit_within(PATIENCE);

        assert_eq!(status.code(), Some(CLAIM_HELD));
        let mut stderr = String::new();
        let mut captured = BufReader::new(second.0.stderr.take().expect("the daemon's stderr"));
        while captured.read_line(&mut stderr).expect("stderr") > 0 {}
        assert!(
            stderr.contains("a Marbles process already runs here"),
            "{stderr}"
        );
    }

    #[test]
    fn a_stop_signal_during_a_slow_initializer_exits_cleanly_and_releases_the_claim() {
        let home = home();
        let state = home.path().join("marbles");
        let mut slow = daemon(
            home.path(),
            &[
                "--init-cmd",
                "sh",
                "--init-arg",
                "-c",
                "--init-arg",
                "sleep 60",
            ],
        );
        wait_for(&state.join("process.json"));

        slow.terminate();
        let status = slow.exit_within(PATIENCE);

        assert!(status.success(), "{status}");
        assert!(!state.join("process.json").exists());
        assert!(!state.join("locks").join("process").exists());

        let mut next = daemon(home.path(), &[]);
        let mut printed = BufReader::new(next.0.stdout.take().expect("the daemon's stdout"));
        let mut line = String::new();
        printed.read_line(&mut line).expect("the first line");
        assert!(line.starts_with("[marbles] pid "), "{line}");
    }
}
