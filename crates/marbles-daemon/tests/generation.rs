mod generation {
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::Duration;

    use marbles_daemon::Layout;
    use marbles_daemon::channel::{self, ChannelEvent};
    use marbles_daemon::generation::{SubprocessLauncher, TimingConfig};
    use marbles_daemon::identity::{pid_exists, this_process};
    use marbles_daemon::lifecycle::{self, DaemonHandle, DaemonOptions, OutputSink};
    use marbles_daemon::protocol::{
        DaemonMethod, GenerationMethod, MAX_LINE_BYTES, Response, WireError, WorkspaceState,
        WorkspaceSummary,
    };
    use serde_json::{Value, json};
    use tokio::net::UnixStream;
    use tokio::signal::unix::{SignalKind, signal};

    const CHILD: &str = "generation::child";
    const PATIENCE: Duration = Duration::from_secs(20);
    const LONG_LINE_EXTRA: usize = 10;

    #[derive(Clone, Default)]
    struct Printed(Arc<Mutex<Vec<String>>>);

    impl Printed {
        fn has(&self, wanted: impl Fn(&str) -> bool) -> bool {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .iter()
                .any(|line| wanted(line))
        }
    }

    impl OutputSink for Printed {
        fn line(&self, line: &str) {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(line.to_owned());
        }
    }

    struct Child {
        mode: String,
        root: String,
        socket: PathBuf,
        token: String,
    }

    fn child_args() -> Option<Child> {
        let args: Vec<String> = env::args().collect();
        let after = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .and_then(|at| args.get(at + 1))
                .cloned()
        };
        let prefixed = |prefix: &str| {
            args.iter()
                .find_map(|arg| arg.strip_prefix(prefix).map(str::to_owned))
        };
        Some(Child {
            mode: prefixed("--mode=")?,
            root: prefixed("--root=")?,
            socket: PathBuf::from(after("--socket")?),
            token: after("--token")?,
        })
    }

    #[test]
    fn child() {
        let Some(child) = child_args() else {
            return;
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("the child's runtime");
        runtime.block_on(serve(child));
    }

    async fn serve(child: Child) {
        let mut terminate = signal(SignalKind::terminate()).expect("the TERM handler");
        let cwd = env::current_dir().map(|dir| dir.display().to_string());
        println!();
        eprintln!(
            "home {} · cwd {}",
            env::var("FOUNDRY_ROOT").unwrap_or_default(),
            cwd.unwrap_or_default()
        );
        let stream = UnixStream::connect(&child.socket)
            .await
            .expect("the daemon socket");
        let (channel, mut events) = channel::open(stream);
        channel
            .request(
                DaemonMethod::Register,
                Some(json!({ "token": child.token })),
            )
            .await
            .expect("the registration");
        let loads = json!([{ "root": child.root }]);
        while let Some(event) = events.recv().await {
            let ChannelEvent::Request(request) = event else {
                break;
            };
            let method = request.method.as_str().parse::<GenerationMethod>();
            match method {
                Ok(GenerationMethod::Load) => {
                    let identity = this_process();
                    let loaded = json!({ "identity": identity, "loads": loads });
                    let _ = channel.respond(Response::ok(request.id, loaded));
                }
                Ok(GenerationMethod::Start) => {
                    println!("  indented stdout");
                    println!();
                    eprintln!("stderr says hi");
                    println!("{}", "x".repeat(MAX_LINE_BYTES + LONG_LINE_EXTRA));
                    let _ = channel.respond(Response::ok(request.id, json!({ "loads": loads })));
                    if child.mode == "deaf" {
                        channel.close();
                        println!("deaf now");
                        loop {
                            terminate.recv().await;
                        }
                    }
                }
                Ok(GenerationMethod::Stop) => {
                    let _ = channel.respond(Response::empty(request.id));
                    channel.close();
                    return;
                }
                _ => {
                    let refusal = WireError::new(format!("no method {}", request.method));
                    let _ = channel.respond(Response::err(request.id, refusal));
                }
            }
        }
    }

    struct Fixture {
        _home: tempfile::TempDir,
        _repo: tempfile::TempDir,
        layout: Layout,
        source: String,
        root: String,
    }

    fn fixture() -> Fixture {
        let home = tempfile::Builder::new()
            .prefix("md")
            .tempdir_in("/tmp")
            .expect("a temporary home");
        let repo = tempfile::tempdir().expect("a workspace directory");
        let root = fs::canonicalize(repo.path()).expect("the canonical root");
        let source = root.join(".foundry/marbles");
        fs::create_dir_all(&source).expect("the authoring folder");
        Fixture {
            layout: Layout::from_home(home.path()),
            _home: home,
            _repo: repo,
            source: source.display().to_string(),
            root: root.display().to_string(),
        }
    }

    fn launcher(mode: &str, root: &str) -> SubprocessLauncher {
        let program = env::current_exe().expect("the test binary");
        SubprocessLauncher::new(
            program,
            [
                CHILD.to_owned(),
                "--exact".to_owned(),
                "--nocapture".to_owned(),
                "--test-threads=1".to_owned(),
                "--".to_owned(),
                format!("--mode={mode}"),
                format!("--root={root}"),
            ],
        )
    }

    fn timings() -> TimingConfig {
        TimingConfig {
            ready_timeout: PATIENCE,
            stop_timeout: Duration::from_millis(500),
            ..TimingConfig::default()
        }
    }

    async fn start(fixture: &Fixture, mode: &str, printed: &Printed) -> DaemonHandle {
        let options = DaemonOptions::new(fixture.layout.clone(), "9.9.9")
            .with_output(printed.clone())
            .with_launcher(launcher(mode, &fixture.root))
            .with_timings(timings());
        lifecycle::start(options).await.expect("the daemon")
    }

    async fn attach(fixture: &Fixture) -> WorkspaceSummary {
        let stream = UnixStream::connect(&fixture.layout.socket)
            .await
            .expect("the daemon socket");
        let (client, _events) = channel::open(stream);
        let attached = client
            .request(
                DaemonMethod::Attach,
                Some(json!({ "source": fixture.source })),
            )
            .await
            .expect("the attach");
        serde_json::from_value(attached.unwrap_or(Value::Null)).expect("a workspace summary")
    }

    async fn printed_eventually(printed: &Printed, wanted: impl Fn(&str) -> bool) {
        tokio::time::timeout(PATIENCE, async {
            while !printed.has(&wanted) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the line should be printed");
    }

    fn run(test: impl std::future::Future<Output = ()>) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("the runtime");
        runtime.block_on(async {
            tokio::time::timeout(PATIENCE * 2, test)
                .await
                .expect("the test should finish in time");
        });
    }

    #[test]
    fn a_real_generation_registers_answers_and_stops_cleanly() {
        run(async {
            let fixture = fixture();
            let printed = Printed::default();
            let daemon = start(&fixture, "cooperative", &printed).await;

            let summary = attach(&fixture).await;

            assert_eq!(summary.state, WorkspaceState::Ready);
            assert_eq!(summary.root, fixture.root);
            let pid = summary.pid.expect("the generation's pid");
            let environment = format!(
                "[generation 1] home {} · cwd {}",
                fixture.layout.home.display(),
                fs::canonicalize(&fixture.layout.state)
                    .expect("the state root")
                    .display()
            );
            printed_eventually(&printed, |line| line == environment).await;
            printed_eventually(&printed, |line| line == "[generation 1]   indented stdout").await;
            printed_eventually(&printed, |line| line == "[generation 1] ").await;
            printed_eventually(&printed, |line| line == "[generation 1] stderr says hi").await;
            let truncated = format!(
                "[generation 1] {} [line truncated at {MAX_LINE_BYTES} bytes]",
                "x".repeat(MAX_LINE_BYTES)
            );
            printed_eventually(&printed, |line| line == truncated).await;

            daemon.shutdown().await;

            assert!(!printed.has(|line| line.contains("killing it")));
            assert!(!pid_exists(pid));
        });
    }

    #[test]
    fn a_generation_that_stops_listening_is_terminated_then_killed() {
        run(async {
            let fixture = fixture();
            let printed = Printed::default();
            let daemon = start(&fixture, "deaf", &printed).await;
            let summary = attach(&fixture).await;
            let pid = summary.pid.expect("the generation's pid");
            printed_eventually(&printed, |line| line == "[generation 1] deaf now").await;

            daemon.shutdown().await;

            assert!(
                printed.has(
                    |line| line == "[marbles] engine generation 1's exit timed out; killing it"
                )
            );
            assert!(!printed.has(|line| line.contains("is not sent")));
            assert!(!pid_exists(pid));
        });
    }
}
