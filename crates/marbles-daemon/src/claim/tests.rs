use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::identity::this_process;

const LIVE_PID: u32 = 1;
const VERSION: &str = "0.0.4";

fn gone_pid() -> u32 {
    let mut child = Command::new("true").spawn().expect("true should spawn");
    child.wait().expect("the child should be reaped");
    child.id()
}

fn layout_in(dir: &tempfile::TempDir) -> Layout {
    Layout::from_home(dir.path().join("home"))
}

fn lock_path(state: &Path) -> PathBuf {
    state.join(LOCKS_DIR).join(PROCESS_LOCK)
}

fn plant_lock(state: &Path, pid: u32) {
    fs::create_dir_all(state.join(LOCKS_DIR)).expect("the locks directory");
    fs::write(lock_path(state), pid.to_string()).expect("the foreign lock");
}

fn recorded(pid: u32) -> RecordedProcess {
    RecordedProcess {
        artifacts: Some(PathBuf::from("/h/artifacts")),
        config: None,
        host: ProcessHost::Daemon,
        pid,
        socket: Some(PathBuf::from("/h/marbles/marbles.sock")),
        started_at: "2026-11-25T14:46:24.123Z".to_owned(),
        marbles_version: Some(VERSION.to_owned()),
    }
}

fn record(state: &Path, pid: u32) {
    recorded(pid)
        .write(&state.join(PROCESS_FILE))
        .expect("the descriptor");
}

fn described(pid: u32, alive: bool) -> ProcessStatus {
    ProcessStatus {
        alive,
        pid,
        recorded: Some(recorded(pid)),
    }
}

fn undescribed(pid: u32, alive: bool) -> ProcessStatus {
    ProcessStatus {
        alive,
        pid,
        recorded: None,
    }
}

#[test]
fn acquiring_secures_the_state_root_and_records_the_process() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let layout = layout_in(&dir);
    let claim = ProcessClaim::acquire(&layout, VERSION).expect("the claim");

    let mode = fs::metadata(&layout.state)
        .expect("the state root")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, STATE_MODE);
    assert!(claim.is_held());
    assert_eq!(claim.started_at().len(), "2026-11-25T14:46:24.123Z".len());
    assert!(claim.started_at().ends_with('Z'));
    assert_eq!(
        read_process(&layout.state),
        Some(ProcessStatus {
            alive: true,
            pid: std::process::id(),
            recorded: Some(RecordedProcess {
                artifacts: Some(layout.artifacts.clone()),
                socket: Some(layout.socket.clone()),
                pid: std::process::id(),
                started_at: claim.started_at().to_owned(),
                ..recorded(0)
            }),
        })
    );
}

#[test]
fn a_held_claim_refuses_a_second_claimant() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let layout = layout_in(&dir);
    let claim = ProcessClaim::acquire(&layout, VERSION).expect("the claim");

    let Err(error) = ProcessClaim::acquire(&layout, VERSION) else {
        panic!("the second claim should be refused");
    };
    assert_eq!(
        error.to_string(),
        format!(
            "a Marbles process already runs here: pid {} (daemon) since {}. Stop it first, or set FOUNDRY_HOME to another Foundry home (state: {}).",
            std::process::id(),
            claim.started_at(),
            layout.state.display()
        )
    );
    assert!(claim.is_held());
}

#[test]
fn a_claim_from_a_gone_process_is_taken_over() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let layout = layout_in(&dir);
    let gone = gone_pid();
    plant_lock(&layout.state, gone);
    record(&layout.state, gone);

    let claim = ProcessClaim::acquire(&layout, VERSION).expect("the claim");

    assert!(claim.is_held());
    assert_eq!(lock_owner(&lock_path(&layout.state)), Some(this_process()));
    assert_eq!(
        read_process(&layout.state).map(|status| status.pid),
        Some(std::process::id())
    );
}

#[test]
fn a_live_foreign_claim_is_described_in_the_refusal() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let layout = layout_in(&dir);
    plant_lock(&layout.state, LIVE_PID);
    record(&layout.state, LIVE_PID);

    let Err(ClaimError::AlreadyHeld {
        holder_description,
        last_recorded,
        ..
    }) = ProcessClaim::acquire(&layout, VERSION)
    else {
        panic!("a live foreign claim should be refused");
    };
    assert_eq!(holder_description, format!("pid {LIVE_PID}"));
    assert_eq!(last_recorded.as_deref(), Some(&described(LIVE_PID, true)));
}

#[test]
fn releasing_removes_the_descriptor_and_lock() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let layout = layout_in(&dir);
    ProcessClaim::acquire(&layout, VERSION)
        .expect("the claim")
        .release();

    assert!(!layout.state.join(PROCESS_FILE).exists());
    assert!(!lock_path(&layout.state).exists());
    assert_eq!(read_process(&layout.state), None);
}

#[test]
fn dropping_the_claim_releases_it() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let layout = layout_in(&dir);
    drop(ProcessClaim::acquire(&layout, VERSION).expect("the claim"));

    assert!(!layout.state.join(PROCESS_FILE).exists());
    assert!(!lock_path(&layout.state).exists());
}

#[test]
fn releasing_spares_a_successor() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let layout = layout_in(&dir);
    let claim = ProcessClaim::acquire(&layout, VERSION).expect("the claim");
    fs::remove_file(lock_path(&layout.state)).expect("the lock");
    plant_lock(&layout.state, LIVE_PID);
    record(&layout.state, LIVE_PID);

    assert!(!claim.is_held());
    claim.release();
    assert_eq!(read_process(&layout.state), Some(described(LIVE_PID, true)));
}

#[test]
fn an_empty_state_root_has_no_process() {
    let dir = tempfile::tempdir().expect("a temporary directory");

    assert_eq!(read_process(&layout_in(&dir).state), None);
}

#[test]
fn a_lock_without_a_descriptor_reports_only_the_pid() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let state = layout_in(&dir).state;
    plant_lock(&state, LIVE_PID);

    assert_eq!(read_process(&state), Some(undescribed(LIVE_PID, true)));
}

#[test]
fn a_descriptor_without_a_lock_is_not_alive() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let state = layout_in(&dir).state;
    fs::create_dir_all(&state).expect("the state root");
    record(&state, LIVE_PID);

    assert_eq!(read_process(&state), Some(described(LIVE_PID, false)));
}

#[test]
fn a_descriptor_for_another_pid_is_ignored() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let state = layout_in(&dir).state;
    plant_lock(&state, LIVE_PID);
    record(&state, LIVE_PID + 1);

    assert_eq!(read_process(&state), Some(undescribed(LIVE_PID, true)));
}

#[test]
fn a_gone_holder_is_not_alive() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let state = layout_in(&dir).state;
    let gone = gone_pid();
    plant_lock(&state, gone);
    record(&state, gone);

    assert_eq!(read_process(&state), Some(described(gone, false)));
}

mod typescript {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    use serde_json::{Value, json};

    use super::*;
    use crate::identity::read_start;

    const READ_RUST_CLAIM: &str = r#"
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { lockOwner } from "@foundry/lib/file-lock";
import { readProcess } from "./src/process/instance.ts";
const state = process.env.MARBLES_STATE;
const lock = join(state, "locks", "process");
const stat = statSync(lock);
const owner = lockOwner(lock);
const note = JSON.stringify({ ctimeMs: stat.ctimeMs, ino: stat.ino, pid: owner?.pid, started: owner?.started });
console.log(JSON.stringify({ owner, status: readProcess(state), noteBytesMatch: readFileSync(`${lock}.owner`, "utf8") === note }));
"#;

    const HOLD_TYPESCRIPT_CLAIM: &str = r#"
import { claimProcess } from "./src/process/instance.ts";
const claim = claimProcess(process.env.MARBLES_STATE, {
  artifacts: "/h/artifacts",
  host: "daemon",
  socket: "/h/marbles/marbles.sock",
  version: "0.0.4",
});
process.stdout.write("ready\n");
for await (const _ of process.stdin) {}
claim.release();
"#;

    fn bun(script: &str, state: &Path) -> Command {
        let mut command = Command::new("bun");
        command
            .args(["-e", script])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/marbles"))
            .env("MARBLES_STATE", state);
        command
    }

    #[test]
    #[ignore = "needs Bun and the installed Marbles workspace"]
    fn typescript_reads_a_rust_claim() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let layout = layout_in(&dir);
        let claim = ProcessClaim::acquire(&layout, VERSION).expect("the claim");

        let output = bun(READ_RUST_CLAIM, &layout.state)
            .output()
            .expect("bun should run");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let read: Value = serde_json::from_slice(&output.stdout).expect("bun should print JSON");

        let own = this_process();
        assert_eq!(
            read["owner"],
            json!({ "pid": own.pid, "started": own.started })
        );
        assert_eq!(read["noteBytesMatch"], json!(true));
        assert_eq!(
            read["status"],
            json!({
                "alive": true,
                "artifacts": layout.artifacts,
                "config": null,
                "host": "daemon",
                "pid": own.pid,
                "socket": layout.socket,
                "startedAt": claim.started_at(),
                "version": VERSION,
            })
        );
    }

    #[test]
    #[ignore = "needs Bun and the installed Marbles workspace"]
    fn rust_reads_a_typescript_claim() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let layout = layout_in(&dir);
        let state = layout.state.clone();
        let mut child = bun(HOLD_TYPESCRIPT_CLAIM, &state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("bun should spawn");
        let mut ready = String::new();
        BufReader::new(child.stdout.take().expect("bun's stdout"))
            .read_line(&mut ready)
            .expect("bun should report the claim");
        assert_eq!(ready, "ready\n");

        let holder = child.id();
        let owner = lock_owner(&lock_path(&state)).expect("the TypeScript lock");
        assert_eq!(owner.started, read_start(holder).known());
        assert!(owner.started.is_some());
        assert!(!is_gone(&owner));
        let status = read_process(&state).expect("the TypeScript descriptor");
        let started = status
            .recorded
            .as_ref()
            .map(|recorded| recorded.started_at.clone())
            .expect("the TypeScript start");
        assert_eq!(
            status,
            ProcessStatus {
                recorded: Some(RecordedProcess {
                    started_at: started,
                    ..recorded(holder)
                }),
                ..described(holder, true)
            }
        );
        let Err(ClaimError::AlreadyHeld {
            holder_description: described_holder,
            ..
        }) = ProcessClaim::acquire(&layout, VERSION)
        else {
            panic!("the TypeScript claim should hold");
        };
        assert_eq!(described_holder, format!("pid {holder}"));

        drop(child.stdin.take());
        assert!(child.wait().expect("bun should exit").success());
        assert_eq!(read_process(&state), None);
    }
}
