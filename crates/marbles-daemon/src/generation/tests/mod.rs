mod failures;
mod mock;
mod registration;
mod routing;
mod sweeping;
mod switching;
mod teardown;
mod watching;

use std::fs;
use std::time::Duration;

use serde_json::{Value, json};

use self::mock::{MockLauncher, World, mock_pid};
use super::TimingConfig;
use super::workspace::workspace_id;
use crate::channel::ChannelError;
use crate::lifecycle::{self, DaemonHandle, DaemonOptions};
use crate::protocol::{
    ClientNotification, DaemonMethod, NonEmptyString, WorkspaceState, WorkspaceSummary,
};
use crate::test_support::{Client, Home, Printed, eventually, home, within};

struct Repo {
    _dir: tempfile::TempDir,
    source: String,
    root: String,
    id: String,
}

fn repo() -> Repo {
    let dir = tempfile::tempdir().expect("a workspace directory");
    let root = fs::canonicalize(dir.path()).expect("the canonical root");
    let source = root.join(".foundry/marbles");
    fs::create_dir_all(&source).expect("the authoring folder");
    let root = root.display().to_string();
    Repo {
        _dir: dir,
        source: source.display().to_string(),
        id: workspace_id(&root),
        root,
    }
}

fn timings() -> TimingConfig {
    TimingConfig {
        ready_timeout: Duration::from_secs(5),
        stop_timeout: Duration::from_millis(500),
        replace_min: Duration::from_millis(50),
        replace_max: Duration::from_millis(200),
        stable: Duration::from_secs(30),
        handover_attempts: 5,
        handover_retry: Duration::from_millis(10),
        held_wait: Duration::from_secs(2),
        live_work_wait: Duration::from_millis(200),
        source_poll: Duration::from_secs(3600),
        switch_debounce: Duration::from_millis(10),
        sweep: Duration::from_secs(3600),
        reoffer: Duration::from_secs(30),
    }
}

struct Daemon {
    home: Home,
    handle: DaemonHandle,
    world: World,
    printed: Printed,
}

async fn daemon(world: &World) -> Daemon {
    daemon_with(world, |options| options).await
}

async fn daemon_with(world: &World, adjust: impl FnOnce(DaemonOptions) -> DaemonOptions) -> Daemon {
    let home = home();
    let printed = Printed::default();
    let options = DaemonOptions::new(home.layout.clone(), "9.9.9")
        .with_output(printed.clone())
        .with_launcher(MockLauncher {
            world: world.clone(),
        })
        .with_timings(timings());
    let handle = within(lifecycle::start(adjust(options)))
        .await
        .expect("the daemon should start");
    Daemon {
        home,
        handle,
        world: world.clone(),
        printed,
    }
}

impl Daemon {
    async fn client(&self) -> Client {
        Client::connect(&self.home.layout.socket).await
    }

    async fn attach(&self, client: &Client, repo: &Repo) -> Result<WorkspaceSummary, ChannelError> {
        self.world.register_root(&repo.root);
        let attached = client
            .ask(DaemonMethod::Attach, Some(json!({ "source": repo.source })))
            .await?;
        Ok(summary_of(attached))
    }

    async fn reload(&self, client: &Client, repo: &Repo) -> Result<WorkspaceSummary, ChannelError> {
        let reloaded = client
            .ask(DaemonMethod::Reload, Some(json!({ "id": repo.id })))
            .await?;
        Ok(summary_of(reloaded))
    }

    async fn exited(&self, number: u64) {
        let world = self.world.clone();
        eventually(move || world.exit_of(number).is_some()).await;
    }
}

async fn ask(client: &Client, method: &str, params: Value) -> Result<Option<Value>, ChannelError> {
    let method = NonEmptyString::try_from(method.to_owned()).expect("a method name");
    client.ask(method, Some(params)).await
}

fn summary_of(value: Option<Value>) -> WorkspaceSummary {
    serde_json::from_value(value.unwrap_or(Value::Null)).expect("a workspace summary")
}

fn remote(error: ChannelError) -> String {
    match error {
        ChannelError::Remote(error) => error.message,
        ChannelError::Closed => "the connection closed".to_owned(),
    }
}

fn answered_by(value: Option<Value>) -> Option<u64> {
    value?.get("generation")?.as_u64()
}

async fn subscribe(client: &Client, repo: &Repo) {
    client
        .ask(DaemonMethod::Subscribe, Some(json!({ "id": repo.id })))
        .await
        .expect("the subscription");
}

async fn workspace_state(client: &mut Client, wanted: WorkspaceState) -> WorkspaceSummary {
    loop {
        let notification = client.notification().await;
        if notification.method.as_str() != ClientNotification::Workspace.as_str() {
            continue;
        }
        let summary = summary_of(notification.params);
        if summary.state == wanted {
            return summary;
        }
    }
}

fn ready_on(repo: &Repo, number: u64) -> WorkspaceSummary {
    WorkspaceSummary {
        config: Some(repo.source.clone()),
        error: None,
        id: repo.id.clone(),
        pid: Some(mock_pid(number)),
        root: repo.root.clone(),
        state: WorkspaceState::Ready,
    }
}
