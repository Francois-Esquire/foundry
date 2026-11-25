use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use serde_json::json;

use super::mock::{Answer, Plan};
use super::*;
use crate::lifecycle::{DaemonExit, LifecyclePhase};
use crate::protocol::DaemonMethod;
use crate::recycle::BinaryWatch;

#[tokio::test]
async fn detaching_unhosts_from_every_hosting_generation() {
    let world = World::default();
    world.plan(1, Plan::default().lingering());
    let daemon = daemon(&world).await;
    let mut client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    daemon.reload(&client, &repo).await.expect("the reload");
    subscribe(&client, &repo).await;

    let detached = client
        .ask(DaemonMethod::Detach, Some(json!({ "id": repo.id })))
        .await
        .expect("the detach");

    assert_eq!(detached, None);
    let unhost = [json!({ "id": repo.id })];
    assert_eq!(world.params_of(2, "unhost"), unhost);
    assert_eq!(world.params_of(1, "unhost"), unhost);
    let waiting = workspace_state(&mut client, WorkspaceState::Stopped).await;
    assert_eq!(
        waiting.error.as_deref(),
        Some("detaching: waiting for engine generations 2, 1 to finish its work")
    );
    let stopped = workspace_state(&mut client, WorkspaceState::Stopped).await;
    assert_eq!(stopped.error, None);
    let listed = client
        .ask(DaemonMethod::Workspaces, None)
        .await
        .expect("the listing");
    assert_eq!(listed, Some(json!([])));
    let refused = ask(&client, "workspace.describe", json!({ "id": repo.id }))
        .await
        .map_err(remote);
    assert_eq!(
        refused,
        Err(format!("no workspace \"{}\" is hosted", repo.id))
    );
}

#[tokio::test]
async fn shutting_down_stops_every_live_generation() {
    let world = World::default();
    world.plan(1, Plan::default().lingering());
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    daemon.reload(&client, &repo).await.expect("the reload");

    within(daemon.handle.shutdown()).await;

    for number in [1, 2] {
        assert_eq!(
            world.methods(number).last().map(String::as_str),
            Some("stop")
        );
        assert_eq!(world.exit_of(number).map(|exit| exit.clean), Some(true));
    }
    assert!(!daemon.home.layout.socket.exists());
}

#[tokio::test]
async fn recycling_orphans_generations_without_stopping_them() {
    let world = World::default();
    let bin = tempfile::tempdir().expect("a binary directory");
    let binary = bin.path().join("marbles-daemon");
    install(&binary, b"#!/bin/sh\necho one\n");
    let watch =
        BinaryWatch::for_path(binary.clone(), Duration::from_millis(20)).expect("the watch");
    let daemon = daemon_with(&world, |options| {
        options
            .with_binary_watch(watch)
            .with_binary_poll_interval(Duration::from_millis(10))
    })
    .await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");

    install(&binary, b"#!/bin/sh\necho two\n");

    let exit = within(daemon.handle.wait_exit()).await;
    assert!(matches!(exit, DaemonExit::Recycle(_)));
    assert_eq!(daemon.handle.phase(), LifecyclePhase::Stopped);
    daemon.exited(1).await;
    assert_eq!(
        world.exit_of(1).map(|exit| exit.reason),
        Some("it was orphaned".to_owned())
    );
    assert!(!world.methods(1).contains(&"stop".to_owned()));
}

#[tokio::test]
async fn recycling_mid_switch_never_stops_the_retiring_generation() {
    let world = World::default();
    world.plan(
        1,
        Plan::default()
            .lingering()
            .answering("retire", [Answer::Silent]),
    );
    let bin = tempfile::tempdir().expect("a binary directory");
    let binary = bin.path().join("marbles-daemon");
    install(&binary, b"#!/bin/sh\necho one\n");
    let watch =
        BinaryWatch::for_path(binary.clone(), Duration::from_millis(20)).expect("the watch");
    let daemon = daemon_with(&world, |options| {
        options
            .with_binary_watch(watch)
            .with_binary_poll_interval(Duration::from_millis(10))
    })
    .await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    let reloading = tokio::spawn(async move {
        let reloaded = client
            .ask(DaemonMethod::Reload, Some(json!({ "id": repo.id })))
            .await;
        drop(client);
        reloaded
    });
    let retiring = world.clone();
    eventually(move || retiring.methods(1).contains(&"retire".to_owned())).await;

    install(&binary, b"#!/bin/sh\necho two\n");

    let exit = within(daemon.handle.wait_exit()).await;
    assert!(matches!(exit, DaemonExit::Recycle(_)));
    daemon.exited(1).await;
    daemon.exited(2).await;
    let _ = within(reloading).await;
    for number in [1, 2] {
        assert_eq!(
            world.exit_of(number).map(|exit| exit.reason),
            Some("it was orphaned".to_owned())
        );
        assert!(!world.methods(number).contains(&"stop".to_owned()));
    }
    assert!(!daemon.printed.has_containing("stopping it"));
    assert!(!daemon.printed.has_containing("killing it"));
    assert!(!daemon.printed.has_containing("is not sent"));
}

fn install(path: &std::path::Path, bytes: &[u8]) {
    let staged = path.with_extension("staged");
    fs::write(&staged, bytes).expect("the staged binary");
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)).expect("the mode");
    fs::rename(&staged, path).expect("the installed binary");
}
