use serde_json::json;

use super::*;
use crate::protocol::DaemonMethod;

#[tokio::test]
async fn the_first_attach_spawns_a_generation_that_registers_loads_and_starts() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();

    let summary = daemon.attach(&client, &repo).await.expect("the attach");

    assert_eq!(summary, ready_on(&repo, 1));
    assert_eq!(world.methods(1), ["load", "start"]);
    assert!(daemon.printed.has(&format!(
        "[marbles] engine generation 1 starting: workspace {} attached",
        repo.id
    )));
    assert!(
        daemon
            .printed
            .has("[marbles] engine generation 1 is current")
    );
    let listed = client
        .ask(DaemonMethod::Workspaces, None)
        .await
        .expect("the listing");
    assert_eq!(listed, Some(json!([ready_on(&repo, 1)])));
}

#[tokio::test]
async fn an_unknown_token_is_refused() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let stranger = daemon.client().await;

    let refused = stranger
        .ask(DaemonMethod::Register, Some(json!({ "token": "made-up" })))
        .await
        .map_err(remote);

    assert_eq!(
        refused,
        Err("no engine generation was spawned with this token".to_owned())
    );
}

#[tokio::test]
async fn a_generation_registers_only_once() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    daemon.attach(&client, &repo()).await.expect("the attach");
    let token = world.token_of(1).expect("the first generation's token");
    let impostor = daemon.client().await;

    let refused = impostor
        .ask(
            DaemonMethod::Register,
            Some(json!({ "token": token.as_str() })),
        )
        .await
        .map_err(remote);

    assert_eq!(
        refused,
        Err("engine generation 1 has registered already".to_owned())
    );
}

#[tokio::test]
async fn a_registered_generation_may_only_notify() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    daemon.attach(&client, &repo()).await.expect("the attach");
    let generation = world.channel_of(1).expect("the generation's channel");

    let refused = within(generation.request(DaemonMethod::Hello, None))
        .await
        .map_err(remote);

    assert_eq!(refused, Err("a generation only notifies".to_owned()));
}
