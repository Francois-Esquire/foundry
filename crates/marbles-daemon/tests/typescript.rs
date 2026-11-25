mod typescript {
    use std::fs;
    use std::io::{BufRead, BufReader, Lines};
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};

    const PATIENCE: Duration = Duration::from_secs(20);

    const TALK_TO_THE_RUST_DAEMON: &str = r#"
import { layout } from "./src/layout.ts";
import { connect, stopProcess } from "./src/process/client.ts";
const home = layout({ home: process.env.FOUNDRY_HOME });
const client = await connect({ layout: home, start: false });
const workspaces = await client.workspaces();
const { hello } = client;
client.close();
const stopped = await stopProcess({ layout: home });
console.log(JSON.stringify({ hello, stopped, workspaces }));
"#;

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

    fn marbles_app() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/marbles")
    }

    fn marbles_version() -> String {
        let manifest = fs::read_to_string(marbles_app().join("package.json"))
            .expect("the Marbles package manifest");
        let manifest: Value = serde_json::from_str(&manifest).expect("a JSON manifest");
        manifest["version"]
            .as_str()
            .expect("the Marbles version")
            .to_owned()
    }

    fn next_line(lines: &mut Lines<BufReader<ChildStdout>>) -> String {
        lines
            .next()
            .expect("the daemon should print")
            .expect("readable output")
    }

    #[test]
    #[ignore = "needs Bun and the installed Marbles workspace"]
    fn typescript_client_connects_to_and_stops_the_rust_daemon() {
        let home = tempfile::Builder::new()
            .prefix("md")
            .tempdir_in("/tmp")
            .expect("a temporary home");
        let state = home.path().join("marbles");
        let socket = state.join("marbles.sock");
        let version = marbles_version();
        let mut daemon = Daemon(
            Command::new(env!("CARGO_BIN_EXE_marbles-daemon"))
                .arg("--home")
                .arg(home.path())
                .args(["--version", &version])
                .stdout(Stdio::piped())
                .spawn()
                .expect("the daemon should spawn"),
        );
        let pid = daemon.0.id();
        let mut printed =
            BufReader::new(daemon.0.stdout.take().expect("the daemon's stdout")).lines();
        assert_eq!(
            next_line(&mut printed),
            format!("[marbles] pid {pid} · {}", socket.display())
        );

        let output = Command::new("bun")
            .args(["-e", TALK_TO_THE_RUST_DAEMON])
            .current_dir(marbles_app())
            .env("FOUNDRY_HOME", home.path())
            .output()
            .expect("bun should run");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let talked: Value = serde_json::from_slice(&output.stdout).expect("bun should print JSON");

        let hello = &talked["hello"];
        assert_eq!(hello["pid"], json!(pid));
        assert_eq!(hello["protocol"], json!(1));
        assert_eq!(hello["version"], json!(version));
        assert_eq!(hello["state"], json!(state));
        assert_eq!(hello["artifacts"], json!(home.path().join("artifacts")));
        assert!(hello["startedAt"].is_string());
        assert_eq!(&talked["stopped"], hello);
        assert_eq!(talked["workspaces"], json!([]));
        assert!(daemon.exit_within(PATIENCE).success());
        assert_eq!(next_line(&mut printed), "[marbles] stopping");
        assert!(!state.join("locks").join("process").exists());
        assert!(!state.join("process.json").exists());
        assert!(!socket.exists());
    }
}
