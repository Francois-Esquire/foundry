use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::mock::Plan;
use super::*;
use crate::lifecycle::{Initialization, InitializeTrigger, Initializer};
use crate::protocol::{DaemonMethod, GenerationMethod};

#[derive(Clone, Default)]
struct Counting(Arc<AtomicUsize>);

impl Initializer for Counting {
    fn initialize(&self, trigger: InitializeTrigger) -> Initialization<'_> {
        if trigger == InitializeTrigger::ProcessChange {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn a_second_workspace_is_hosted_by_the_current_generation() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let (first, second) = (repo(), repo());
    daemon
        .attach(&client, &first)
        .await
        .expect("the first attach");

    let summary = daemon
        .attach(&client, &second)
        .await
        .expect("the second attach");

    assert_eq!(summary, ready_on(&second, 1));
    assert_eq!(world.spawned(), 1);
    assert_eq!(world.methods(1), ["load", "start", "host"]);
    assert_eq!(
        world.params_of(1, GenerationMethod::Host.as_str()),
        [json!({ "config": second.source, "root": second.root })]
    );
}

#[tokio::test]
async fn attaching_again_returns_the_hosted_workspace() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");

    let again = daemon
        .attach(&client, &repo)
        .await
        .expect("the second attach");

    assert_eq!(again, ready_on(&repo, 1));
    assert_eq!(world.methods(1), ["load", "start"]);
}

#[tokio::test]
async fn a_workspace_hosted_from_another_source_must_be_detached_first() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    let config = format!("{}/marbles.config.ts", repo.root);
    fs::write(&config, "").expect("a config file");

    let refused = client
        .ask(DaemonMethod::Attach, Some(json!({ "source": config })))
        .await
        .map_err(remote);

    assert_eq!(
        refused,
        Err(format!(
            "workspace {} is hosted from {}; detach it first",
            repo.id, repo.source
        ))
    );
}

#[tokio::test]
async fn a_relative_source_is_refused() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;

    let refused = client
        .ask(DaemonMethod::Attach, Some(json!({ "source": "./repo" })))
        .await
        .map_err(remote);

    assert_eq!(
        refused,
        Err("the source to attach must be absolute, not \"./repo\"".to_owned())
    );
    assert_eq!(world.spawned(), 0);
}

#[tokio::test]
async fn a_reload_switches_generations_without_downtime() {
    let world = World::default();
    let counting = Counting::default();
    let daemon = daemon_with(&world, |options| options.with_initializer(counting.clone())).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");

    let reloaded = daemon.reload(&client, &repo).await.expect("the reload");

    assert_eq!(reloaded, ready_on(&repo, 2));
    let log = world.log();
    let at = |entry: (u64, &str)| {
        log.iter()
            .position(|(number, method)| *number == entry.0 && method == entry.1)
            .expect("the request should be logged")
    };
    assert!(at((2, "load")) < at((1, "retire")));
    assert!(at((1, "retire")) < at((2, "start")));
    assert_eq!(
        world.params_of(1, GenerationMethod::Retire.as_str()),
        [json!({ "successor": { "pid": mock_pid(2), "started": "mock:2" } })]
    );
    daemon.exited(1).await;
    assert_eq!(world.exit_of(1).map(|exit| exit.clean), Some(true));
    assert!(!world.methods(1).contains(&"stop".to_owned()));
    assert_eq!(counting.0.load(Ordering::SeqCst), 2);
    assert!(daemon.printed.has(&format!(
        "[marbles] engine generation 2 starting: workspace {} reloaded",
        repo.id
    )));
}

#[tokio::test]
async fn a_candidate_that_fails_to_load_is_refused_while_the_current_keeps_serving() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    world.plan(2, Plan::default().failing_load(&repo.root, "syntax error"));

    let refused = daemon.reload(&client, &repo).await.map_err(remote);

    assert_eq!(refused, Err("syntax error".to_owned()));
    assert_eq!(world.methods(2), ["load", "stop"]);
    assert!(!world.methods(1).contains(&"retire".to_owned()));
    let described = ask(&client, "workspace.describe", json!({ "id": repo.id }))
        .await
        .expect("the current generation should answer");
    assert_eq!(answered_by(described), Some(1));
    let listed = client
        .ask(DaemonMethod::Workspaces, None)
        .await
        .expect("the listing");
    let said = "a change did not load, so the previous load still runs: syntax error";
    assert_eq!(
        listed,
        Some(json!([WorkspaceSummary {
            error: Some(said.to_owned()),
            ..ready_on(&repo, 1)
        }]))
    );
    assert!(daemon.printed.has(&format!("[{}] {said}", repo.id)));
}

#[tokio::test]
async fn a_crashed_current_generation_is_replaced_after_a_backoff() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let mut client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    subscribe(&client, &repo).await;

    world.crash(1);

    let failed = workspace_state(&mut client, WorkspaceState::Failed).await;
    assert_eq!(failed.error.as_deref(), Some("it crashed"));
    let restored = workspace_state(&mut client, WorkspaceState::Ready).await;
    assert_eq!(restored, ready_on(&repo, 2));
    assert!(
        daemon.printed.has(
            "[marbles] the engine generation exited; the next engine generation starts in 50ms"
        )
    );
    assert!(
        daemon
            .printed
            .has("[marbles] engine generation 1 exited: it crashed")
    );
}

#[tokio::test]
async fn a_promoted_generation_that_fails_to_start_is_stopped_and_replaced() {
    let world = World::default();
    world.plan(2, Plan::default().failing_start("start broke"));
    let daemon = daemon(&world).await;
    let mut client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    subscribe(&client, &repo).await;

    let refused = daemon.reload(&client, &repo).await.map_err(remote);

    assert_eq!(refused, Err("start broke".to_owned()));
    let failed = workspace_state(&mut client, WorkspaceState::Failed).await;
    assert_eq!(failed.error.as_deref(), Some("start broke"));
    assert_eq!(world.methods(2), ["load", "start", "stop"]);
    assert!(world.methods(1).contains(&"retire".to_owned()));
    assert!(daemon.printed.has(
        "[marbles] the engine generation did not start; the next engine generation starts in 50ms"
    ));
    let restored = workspace_state(&mut client, WorkspaceState::Ready).await;
    assert_eq!(restored, ready_on(&repo, 3));
}
