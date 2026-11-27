mod sqlite_contract {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use marbles_daemon::Layout;
    use marbles_daemon::identity::{ProcessIdentity, this_process};
    use marbles_daemon::store::{GenerationState, QueuedRun, StateStore};
    use serde_json::{Value, json};

    const GONE_PID: u32 = 4_999_999;

    const SEED: &str = r#"
import { initializeDatabase } from "./src/database/open.ts";
import { queueRuns } from "@foundry/queue/store/tables";
const gone = { instanceId: "i-1", pid: 4999999, started: "ps:gone" };
const opened = await initializeDatabase(process.env.MARBLES_DATABASE);
const queued = (id, queuedAt, owner) => ({
  body: { id, jobId: "job", state: { availableAt: queuedAt, kind: "queued", owner, queuedAt } },
  id,
  jobId: "job",
  scope: "w1",
  state: "queued",
});
await opened.database.insert(queueRuns).values([
  queued("late", 30, gone),
  queued("early", 10, { pid: 7, started: null }),
  {
    body: { id: "busy", jobId: "job", state: { kind: "running", lease: { claimedAt: 1, owner: gone } } },
    id: "busy",
    jobId: "job",
    scope: "w1",
    state: "running",
  },
]);
opened.close();
"#;

    const READ_BACK: &str = r#"
import { join } from "node:path";
import { queueRuns } from "@foundry/queue/store/tables";
import { and, eq } from "drizzle-orm";
import { readDatabase, readLiveGenerations, recordedWorkspaces } from "./src/database/open.ts";
const state = process.env.MARBLES_STATE;
const workspaces = await recordedWorkspaces(state);
const generations = await readLiveGenerations(state);
const queued = await readDatabase(join(state, "marbles.db"), async (database) => {
  const rows = await database
    .select({ body: queueRuns.body })
    .from(queueRuns)
    .where(and(eq(queueRuns.scope, "w1"), eq(queueRuns.state, "queued")));
  return rows
    .map((row) => row.body)
    .sort((a, b) => a.state.queuedAt - b.state.queuedAt)
    .map((run) => ({
      id: run.id,
      owner: { pid: run.state.owner.pid, started: run.state.owner.started },
    }));
});
console.log(JSON.stringify({ generations, queued, workspaces }));
"#;

    fn marbles_app() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/marbles")
    }

    fn bun(script: &str, layout: &Layout) -> String {
        let output = Command::new("bun")
            .args(["-e", script])
            .current_dir(marbles_app())
            .env("MARBLES_DATABASE", &layout.database)
            .env("MARBLES_STATE", &layout.state)
            .output()
            .expect("bun should run");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn generate_migrations() {
        let generated = Command::new("bun")
            .args(["run", "db:generate"])
            .current_dir(marbles_app())
            .output()
            .expect("bun should generate the migrations");
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
    }

    async fn exercise(store: &StateStore, me: &ProcessIdentity) {
        let gone = ProcessIdentity {
            pid: GONE_PID,
            started: Some("ps:gone".to_owned()),
        };
        store
            .touch_workspace(
                "w1",
                Path::new("/repos/w1"),
                Some(Path::new("/repos/w1/.foundry/marbles")),
                true,
            )
            .await
            .expect("w1 registered");
        store
            .touch_workspace("w2", Path::new("/repos/w2"), None, true)
            .await
            .expect("w2 registered");
        assert_eq!(store.unhost_workspace("w2").await, Ok(true));
        let hosted = store.list_hosted_workspaces().await.expect("the hosted");
        assert_eq!(
            hosted
                .iter()
                .map(|workspace| workspace.id.as_str())
                .collect::<Vec<_>>(),
            ["w1"]
        );
        let w2 = store.read_workspace("w2").await.expect("w2 reads");
        assert!(w2.is_some_and(|w2| !w2.hosted && w2.config.is_none()));

        assert_eq!(store.begin_generation("fp-1").await, Ok(1));
        store
            .record_generation_spawned(1, me.pid, None)
            .await
            .expect("spawned");
        store
            .record_generation_identified(1, me.pid, me.started.as_deref())
            .await
            .expect("identified");
        store
            .record_generation_hosting(1, &["w1".to_owned()])
            .await
            .expect("hosting");
        store
            .mark_generation(1, GenerationState::Current, None)
            .await
            .expect("current");
        assert_eq!(store.begin_generation("fp-2").await, Ok(2));
        store
            .mark_generation(2, GenerationState::Failed, Some("it did not load"))
            .await
            .expect("failed");
        assert_eq!(store.begin_generation("fp-3").await, Ok(3));
        store
            .record_generation_spawned(3, gone.pid, gone.started.as_deref())
            .await
            .expect("spawned");
        store
            .mark_generation(3, GenerationState::Retiring, None)
            .await
            .expect("retiring");

        assert_eq!(store.end_gone_generations().await, Ok(vec![3]));
        store.end_all_generations().await.expect("the ending");
        let first = store.read_generation(1).await.expect("generation 1");
        assert_eq!(
            first.map(|first| first.state),
            Some(GenerationState::Retiring)
        );

        assert_eq!(
            store.queued_runs("w1").await,
            Ok(vec![
                QueuedRun {
                    id: "early".to_owned(),
                    owner: ProcessIdentity {
                        pid: 7,
                        started: None
                    },
                },
                QueuedRun {
                    id: "late".to_owned(),
                    owner: gone.clone(),
                },
            ])
        );
        assert_eq!(store.read_run_owner("w1", "busy").await, Ok(Some(gone)));
        assert_eq!(store.read_run_owner("w1", "absent").await, Ok(None));
    }

    #[test]
    #[ignore = "needs Bun and the installed Marbles workspace"]
    fn typescript_drizzle_schema_round_trips_through_the_sqlite_store() {
        let home = tempfile::Builder::new()
            .prefix("md")
            .tempdir_in("/tmp")
            .expect("a temporary home");
        let layout = Layout::from_home(home.path());
        fs::create_dir_all(&layout.state).expect("the state root");
        generate_migrations();
        bun(SEED, &layout);
        let me = this_process();
        assert!(
            me.started.is_some(),
            "this process's start should be readable"
        );

        let store = StateStore::open_existing_sqlite(&layout)
            .expect("the database opens")
            .expect("the database exists");
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(exercise(&store, &me));

        let read: Value = serde_json::from_str(&bun(READ_BACK, &layout)).expect("bun prints JSON");
        let workspaces = read["workspaces"].as_array().expect("the workspaces");
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0]["id"], json!("w1"));
        assert_eq!(workspaces[0]["hosted"], json!(true));
        assert_eq!(workspaces[0]["root"], json!("/repos/w1"));
        assert_eq!(workspaces[0]["config"], json!("/repos/w1/.foundry/marbles"));
        assert_eq!(workspaces[0]["cwd"], json!("/repos/w1"));
        assert_eq!(workspaces[1]["id"], json!("w2"));
        assert_eq!(workspaces[1]["hosted"], json!(false));
        assert_eq!(
            read["generations"],
            json!([{
                "error": null,
                "fingerprint": "fp-1",
                "number": 1,
                "pid": me.pid,
                "started": me.started,
                "state": "retiring",
                "workspaces": ["w1"],
            }])
        );
        assert_eq!(
            read["queued"],
            json!([
                { "id": "early", "owner": { "pid": 7, "started": null } },
                { "id": "late", "owner": { "pid": GONE_PID, "started": "ps:gone" } },
            ])
        );
    }
}
