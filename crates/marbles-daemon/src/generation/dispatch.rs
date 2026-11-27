use serde_json::{Map, Value};
use tokio::time::Instant;

use super::supervisor::{Supervisor, is_retiring, params_of, within};
use super::switch::Setups;
use crate::identity::{ProcessIdentity, is_gone, may_be_same_process};
use crate::protocol::{
    AttachParams, DaemonRequest, GenerationMethod, SetupDraftParams, WireError, WorkspaceMethod,
    WorkspaceRoute, WorkspaceState, WorkspaceSummary, is_valid_live_runs,
};

const MOVING_RETRY_FACTOR: u32 = 10;

#[derive(Debug)]
pub(crate) enum SupervisedRequest {
    Attach(AttachParams),
    Detach(String),
    Reload(String),
    Workspace {
        method: WorkspaceMethod,
        id: String,
        params: Map<String, Value>,
    },
}

impl SupervisedRequest {
    pub(crate) fn from_request(request: DaemonRequest) -> Result<Self, DaemonRequest> {
        Ok(match request {
            DaemonRequest::Attach(params) => Self::Attach(params),
            DaemonRequest::Detach(params) => Self::Detach(params.id.into()),
            DaemonRequest::Reload(params) => Self::Reload(params.id.into()),
            DaemonRequest::Workspace { method, id, params } => Self::Workspace {
                method,
                id: id.into(),
                params,
            },
            other => return Err(other),
        })
    }
}

fn no_host(id: &str) -> WireError {
    WireError::new(format!("no engine generation hosts workspace {id} now"))
}

enum Owned {
    Answered(Option<Value>),
    Elsewhere,
}

impl Supervisor {
    pub(crate) async fn answer(
        &self,
        request: SupervisedRequest,
    ) -> Result<Option<Value>, WireError> {
        let ready = self.timings().ready_timeout;
        match request {
            SupervisedRequest::Attach(params) => {
                let this = self.clone();
                let summary = self
                    .within_task(ready, "starting the workspace", async move {
                        this.attach(params).await
                    })
                    .await?;
                Ok(params_of(&summary))
            }
            SupervisedRequest::Reload(id) => {
                self.summary_of(&id)?;
                let this = self.clone();
                let reason = format!("workspace {id} reloaded");
                self.within_task(ready, "reloading the workspace", async move {
                    this.switch(&reason, Setups::new()).await
                })
                .await?;
                Ok(params_of(&self.summary_of(&id)?))
            }
            SupervisedRequest::Detach(id) => {
                self.summary_of(&id)?;
                self.detach(&id).await?;
                Ok(None)
            }
            SupervisedRequest::Workspace { method, id, params } => {
                self.workspace_call(method, &id, params).await
            }
        }
    }

    pub(super) fn summary_of(&self, id: &str) -> Result<WorkspaceSummary, WireError> {
        self.lock()
            .hosted
            .get(id)
            .map(|hosted| hosted.summary.clone())
            .ok_or_else(|| unhosted(id))
    }

    async fn workspace_call(
        &self,
        method: WorkspaceMethod,
        id: &str,
        mut params: Map<String, Value>,
    ) -> Result<Option<Value>, WireError> {
        {
            let state = self.lock();
            let hosted = state.hosted.get(id).ok_or_else(|| unhosted(id))?;
            if hosted.detaching && method.dispatches_work() {
                return Err(WireError::new(format!(
                    "workspace {id} is detaching; it starts no new work"
                )));
            }
        }
        params.insert("id".to_owned(), Value::from(id));
        match method.route() {
            WorkspaceRoute::Owner => match self.ask_owner(method, id, &params).await? {
                Owned::Answered(value) => Ok(value),
                Owned::Elsewhere => self.ask_current(method, id, params, false).await,
            },
            WorkspaceRoute::HostsInTurn => {
                self.handovers_settled(id).await;
                self.ask_each(method, id, &params).await
            }
            WorkspaceRoute::CurrentWithLiveWork => self.ask_current(method, id, params, true).await,
            WorkspaceRoute::Current => self.ask_current(method, id, params, false).await,
        }
    }

    async fn ask_owner(
        &self,
        method: WorkspaceMethod,
        id: &str,
        params: &Map<String, Value>,
    ) -> Result<Owned, WireError> {
        let Some(run_id) = params.get("runId").and_then(Value::as_str) else {
            return Ok(Owned::Elsewhere);
        };
        let acting = method != WorkspaceMethod::GetRun;
        let deadline = self.deadline();
        loop {
            let Some(owner) = self.owner_of(id, run_id, acting).await? else {
                return Ok(Owned::Elsewhere);
            };
            match self
                .ask(owner, method, Some(Value::Object(params.clone())))
                .await
            {
                Ok(value) => return Ok(Owned::Answered(value)),
                Err(error) => self.wait_while_moving(&error, deadline).await?,
            }
        }
    }

    async fn owner_of(
        &self,
        id: &str,
        run_id: &str,
        acting: bool,
    ) -> Result<Option<u64>, WireError> {
        let Some(owner) = self.store().read_run_owner(id, run_id).await.ok().flatten() else {
            return Ok(None);
        };
        let found = {
            let state = self.lock();
            state.generations.hosts_of(id).into_iter().find(|number| {
                state
                    .generations
                    .get(*number)
                    .and_then(|generation| generation.identity.as_ref())
                    .is_some_and(|identity| may_be_same_process(identity, &owner))
            })
        };
        if acting && found.is_none() && !gone(&owner).await {
            return Err(WireError::new(format!(
                "run {run_id} is owned by pid {}, which is not an engine generation of this Marbles process",
                owner.pid
            )));
        }
        Ok(found)
    }

    async fn ask_each(
        &self,
        method: WorkspaceMethod,
        id: &str,
        params: &Map<String, Value>,
    ) -> Result<Option<Value>, WireError> {
        let deadline = self.deadline();
        let mut swept = false;
        loop {
            let hosts = self.lock().generations.hosts_of(id);
            if hosts.is_empty() {
                return Err(no_host(id));
            }
            let mut errors = Vec::new();
            for number in hosts {
                match self
                    .ask(number, method, Some(Value::Object(params.clone())))
                    .await
                {
                    Ok(value) => return Ok(value),
                    Err(error) => errors.push(error),
                }
            }
            let moving = errors.iter().any(is_retiring);
            let first = errors
                .iter()
                .find(|error| !is_retiring(error))
                .or_else(|| errors.first())
                .cloned()
                .unwrap_or_else(|| no_host(id));
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || !(moving || !swept) {
                return Err(first);
            }
            if moving {
                self.next_change(left.min(self.moving_retry())).await;
            } else {
                swept = true;
                self.sweep(Some(vec![id.to_owned()]), true).await;
            }
        }
    }

    async fn ask_current(
        &self,
        method: WorkspaceMethod,
        id: &str,
        params: Map<String, Value>,
        gathering: bool,
    ) -> Result<Option<Value>, WireError> {
        let deadline = self.deadline();
        loop {
            let target = self.started_current(id).await?;
            let mut prepared = params.clone();
            if gathering {
                let live = self.live_elsewhere(id, target).await;
                prepared.insert("live".to_owned(), Value::Array(live));
                if !self.lock().generations.is_current(target) {
                    if Instant::now() >= deadline {
                        return Err(WireError::new(format!(
                            "workspace {id} kept switching while reading its live work"
                        )));
                    }
                    continue;
                }
            }
            match self
                .ask(target, method, Some(Value::Object(prepared)))
                .await
            {
                Ok(value) => return Ok(value),
                Err(error) => {
                    if self.lock().generations.is_current(target) {
                        self.wait_while_moving(&error, deadline).await?;
                    } else if !is_retiring(&error) || Instant::now() >= deadline {
                        return Err(error);
                    }
                }
            }
        }
    }

    async fn started_current(&self, id: &str) -> Result<u64, WireError> {
        let target = self.lock().generations.current;
        if let Some(target) = target {
            self.settle(|state| state.generations.start_settled(target).then_some(()))
                .await;
        }
        let state = self.lock();
        let hosted = state.hosted.get(id).ok_or_else(|| unhosted(id))?;
        if hosted.detaching {
            return Err(WireError::new(format!("workspace {id} is detaching")));
        }
        let serving = target.filter(|target| {
            state.generations.is_current(*target)
                && state
                    .generations
                    .get(*target)
                    .is_some_and(|generation| generation.hosts.contains(id))
        });
        match (serving, hosted.summary.state) {
            (Some(target), WorkspaceState::Ready | WorkspaceState::Reloading) => Ok(target),
            _ => Err(WireError::new(hosted.described())),
        }
    }

    async fn live_elsewhere(&self, id: &str, target: u64) -> Vec<Value> {
        let others: Vec<u64> = self
            .lock()
            .generations
            .hosts_of(id)
            .into_iter()
            .filter(|number| *number != target)
            .collect();
        let reads: Vec<_> = others
            .into_iter()
            .map(|number| {
                let this = self.clone();
                let id = id.to_owned();
                tokio::spawn(async move { this.live_of(&id, number).await })
            })
            .collect();
        let mut live = Vec::new();
        for read in reads {
            live.extend(read.await.unwrap_or_default());
        }
        live
    }

    async fn live_of(&self, id: &str, number: u64) -> Vec<Value> {
        let read = within(
            self.timings().live_work_wait,
            &format!("reading the live work of generation {number}"),
            async {
                let reply = self
                    .ask(number, GenerationMethod::LiveWork, Some(id_params(id)))
                    .await?
                    .unwrap_or(Value::Null);
                match reply {
                    Value::Array(runs) if is_valid_live_runs(&Value::Array(runs.clone())) => {
                        Ok(runs)
                    }
                    _ => Err(WireError::new(format!(
                        "the live work of engine generation {number} is malformed"
                    ))),
                }
            },
        )
        .await;
        let key = (id.to_owned(), number);
        match read {
            Ok(runs) => {
                self.lock().live_unread.remove(&key);
                runs
            }
            Err(error) => {
                if self.lock().live_unread.insert(key) {
                    self.print(&format!(
                        "[{id}] the runs of engine generation {number} are left out of the dashboard: {}",
                        error.message
                    ));
                }
                Vec::new()
            }
        }
    }

    fn moving_retry(&self) -> std::time::Duration {
        self.timings().handover_retry * MOVING_RETRY_FACTOR
    }

    fn deadline(&self) -> Instant {
        Instant::now() + self.timings().held_wait
    }

    async fn wait_while_moving(
        &self,
        error: &WireError,
        deadline: Instant,
    ) -> Result<(), WireError> {
        let left = deadline.saturating_duration_since(Instant::now());
        if !is_retiring(error) || left.is_zero() {
            return Err(error.clone());
        }
        self.next_change(left.min(self.moving_retry())).await;
        Ok(())
    }
}

pub(super) fn setups_for(id: &str, setup: Option<SetupDraftParams>) -> Setups {
    setup
        .map(|setup| Setups::from([(id.to_owned(), setup)]))
        .unwrap_or_default()
}

pub(super) fn id_params(id: &str) -> Value {
    Value::Object(Map::from_iter([("id".to_owned(), Value::from(id))]))
}

pub(super) fn unhosted(id: &str) -> WireError {
    WireError::new(format!("no workspace \"{id}\" is hosted"))
}

async fn gone(owner: &ProcessIdentity) -> bool {
    let owner = owner.clone();
    tokio::task::spawn_blocking(move || is_gone(&owner))
        .await
        .unwrap_or(false)
}
