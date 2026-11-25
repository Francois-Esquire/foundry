use std::sync::{Arc, Mutex, PoisonError};

use serde_json::json;

use super::mock::{Answer, Plan};
use super::*;
use crate::generation::{OwnerLookup, ReadObserver, RunOwnerResolver};
use crate::identity::{ProcessIdentity, this_process};
use crate::protocol::{ClientNotification, GenerationMethod, ReadNotificationParams};

#[derive(Clone)]
struct Owners(ProcessIdentity);

impl RunOwnerResolver for Owners {
    fn owner_of(&self, _workspace_id: &str, run_id: &str) -> OwnerLookup<'_> {
        let owner = (run_id == "r1").then(|| self.0.clone());
        Box::pin(async move { owner })
    }
}

#[derive(Clone, Default)]
struct Reads(Arc<Mutex<Vec<(u64, ReadNotificationParams)>>>);

impl ReadObserver for Reads {
    fn read(&self, generation: u64, read: &ReadNotificationParams) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((generation, read.clone()));
    }
}

fn live_runs() -> Value {
    json!([{
        "record": { "id": "r1", "status": "running" },
        "work": [{ "kind": "command", "command": "ls", "id": "u", "input": "stdin", "stepId": "s" }]
    }])
}

async fn retiring_first(daemon: &Daemon, client: &Client, repo: &Repo) {
    daemon.attach(client, repo).await.expect("the attach");
    daemon.reload(client, repo).await.expect("the reload");
}

#[tokio::test]
async fn current_calls_are_retried_while_the_engine_is_retiring() {
    let world = World::default();
    world.plan(
        1,
        Plan::default().answering("workspace.describe", [Answer::Retiring, Answer::Echo]),
    );
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");

    let described = ask(
        &client,
        "workspace.describe",
        json!({ "verbose": true, "id": repo.id }),
    )
    .await
    .expect("the retried call");

    assert_eq!(
        described,
        Some(json!({
            "generation": 1,
            "method": "workspace.describe",
            "params": { "verbose": true, "id": repo.id },
        }))
    );
    assert_eq!(world.params_of(1, "workspace.describe").len(), 2);
}

#[tokio::test]
async fn answers_fall_back_to_a_retiring_generation_when_the_current_one_refuses() {
    let world = World::default();
    world.plan(1, Plan::default().lingering());
    world.plan(
        2,
        Plan::default().answering(
            "workspace.answer",
            [Answer::Fail("no such question".to_owned())],
        ),
    );
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    retiring_first(&daemon, &client, &repo).await;

    let answered = ask(
        &client,
        "workspace.answer",
        json!({ "id": repo.id, "runId": "r7" }),
    )
    .await
    .expect("the retiring generation should answer");

    assert_eq!(answered_by(answered), Some(1));
    assert_eq!(world.params_of(2, "workspace.answer").len(), 1);
}

#[tokio::test]
async fn snapshots_gather_the_live_work_of_retiring_generations() {
    let world = World::default();
    world.plan(
        1,
        Plan::default().lingering().answering(
            GenerationMethod::LiveWork.as_str(),
            [Answer::Value(live_runs())],
        ),
    );
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    retiring_first(&daemon, &client, &repo).await;

    let snapshot = ask(&client, "workspace.snapshot", json!({ "id": repo.id }))
        .await
        .expect("the snapshot");

    assert_eq!(answered_by(snapshot.clone()), Some(2));
    assert_eq!(
        snapshot.map(|snapshot| snapshot["params"].clone()),
        Some(json!({ "id": repo.id, "live": live_runs() }))
    );
    assert_eq!(
        world.params_of(1, GenerationMethod::LiveWork.as_str()),
        [json!({ "id": repo.id })]
    );
}

#[tokio::test]
async fn malformed_or_silent_live_work_is_left_out_without_failing_the_snapshot() {
    for answer in [Answer::Value(json!({ "not": "runs" })), Answer::Silent] {
        let world = World::default();
        world.plan(
            1,
            Plan::default()
                .lingering()
                .answering(GenerationMethod::LiveWork.as_str(), [answer]),
        );
        let daemon = daemon(&world).await;
        let client = daemon.client().await;
        let repo = repo();
        retiring_first(&daemon, &client, &repo).await;

        let snapshot = ask(&client, "workspace.snapshot", json!({ "id": repo.id }))
            .await
            .expect("the snapshot");

        assert_eq!(
            snapshot.map(|snapshot| snapshot["params"]["live"].clone()),
            Some(json!([]))
        );
        assert!(daemon.printed.has_containing(&format!(
            "[{}] the runs of engine generation 1 are left out of the dashboard: ",
            repo.id
        )));
    }
}

#[tokio::test]
async fn run_calls_go_to_the_generation_that_owns_the_run() {
    let world = World::default();
    world.plan(1, Plan::default().lingering());
    let owner = ProcessIdentity {
        pid: mock_pid(1),
        started: Some("mock:1".to_owned()),
    };
    let daemon = daemon_with(&world, |options| options.with_run_owners(Owners(owner))).await;
    let client = daemon.client().await;
    let repo = repo();
    retiring_first(&daemon, &client, &repo).await;

    let owned = ask(
        &client,
        "workspace.cancelRun",
        json!({ "id": repo.id, "runId": "r1" }),
    )
    .await
    .expect("the owner should answer");
    let unowned = ask(
        &client,
        "workspace.cancelRun",
        json!({ "id": repo.id, "runId": "r2" }),
    )
    .await
    .expect("the current generation should answer");

    assert_eq!(answered_by(owned), Some(1));
    assert_eq!(answered_by(unowned), Some(2));
}

#[tokio::test]
async fn a_run_owned_by_a_live_stranger_refuses_changes_but_can_be_read() {
    let world = World::default();
    let stranger = this_process();
    let pid = stranger.pid;
    let daemon = daemon_with(&world, |options| options.with_run_owners(Owners(stranger))).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");

    let refused = ask(
        &client,
        "workspace.pause",
        json!({ "id": repo.id, "runId": "r1" }),
    )
    .await
    .map_err(remote);
    let read = ask(
        &client,
        "workspace.getRun",
        json!({ "id": repo.id, "runId": "r1" }),
    )
    .await
    .expect("a read falls through to the current generation");

    assert_eq!(
        refused,
        Err(format!(
            "run r1 is owned by pid {pid}, which is not an engine generation of this Marbles process"
        ))
    );
    assert_eq!(answered_by(read), Some(1));
}

#[tokio::test]
async fn a_handed_run_is_offered_to_the_current_generation() {
    let world = World::default();
    world.plan(1, Plan::default().lingering());
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    retiring_first(&daemon, &client, &repo).await;

    world.notify(1, "handed", json!({ "id": repo.id, "runId": "r9" }));

    let offered = world.clone();
    eventually(move || !offered.params_of(2, "takeHanded").is_empty()).await;
    assert_eq!(
        world.params_of(2, "takeHanded"),
        [json!({ "id": repo.id, "runId": "r9" })]
    );
}

#[tokio::test]
async fn a_declined_hand_over_is_offered_again_a_bounded_number_of_times() {
    let world = World::default();
    world.plan(1, Plan::default().lingering());
    world.plan(
        2,
        Plan::default().answering("takeHanded", [Answer::Value(json!(false))]),
    );
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    retiring_first(&daemon, &client, &repo).await;

    world.notify(1, "handed", json!({ "id": repo.id, "runId": "r9" }));

    let offered = world.clone();
    eventually(move || offered.params_of(2, "takeHanded").len() == 5).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(world.params_of(2, "takeHanded").len(), 5);
}

#[tokio::test]
async fn generation_lines_reach_subscribers_and_reads_reach_the_observer() {
    let world = World::default();
    let reads = Reads::default();
    let daemon = daemon_with(&world, |options| options.with_read_observer(reads.clone())).await;
    let mut client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    subscribe(&client, &repo).await;

    world.notify(
        1,
        "line",
        json!({ "line": "  indented", "root": repo.root }),
    );
    world.notify(1, "line", json!({ "line": "plain" }));
    world.notify(
        1,
        "read",
        json!({ "file": "/elsewhere/a.ts", "readAt": 7, "root": repo.root }),
    );

    let heard = client.notification().await;
    assert_eq!(heard.method.as_str(), ClientNotification::Line.as_str());
    assert_eq!(
        heard.params,
        Some(json!({ "id": repo.id, "line": "  indented" }))
    );
    let printed = daemon.printed.clone();
    eventually(move || printed.has("[generation 1] plain")).await;
    let observed = reads.clone();
    eventually(move || {
        !observed
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    })
    .await;
    assert_eq!(
        reads
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone(),
        [(
            1,
            ReadNotificationParams {
                file: "/elsewhere/a.ts".to_owned(),
                read_at: 7,
                root: repo.root.clone(),
            }
        )]
    );
    assert!(daemon.printed.has(&format!("[{}]   indented", repo.id)));
}
