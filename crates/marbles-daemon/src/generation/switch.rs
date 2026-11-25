use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use tokio::time::Instant;

use super::registry::GenerationRole;
use super::supervisor::{State, Supervisor, params_of, reply_of, within};
use crate::identity::ProcessIdentity;
use crate::protocol::{
    GenerationMethod, LoadResult, RetireParams, SetupDraftParams, StartParams, StartResult,
    WireError, WorkspaceLoadResult, WorkspaceState,
};

pub(super) type Setups = BTreeMap<String, SetupDraftParams>;

enum Refusal {
    Failed(WireError),
    Loads(Vec<WorkspaceLoadResult>),
}

impl Refusal {
    fn into_error(self) -> WireError {
        match self {
            Self::Failed(error) => error,
            Self::Loads(loads) => WireError::new(loads_message(&loads)),
        }
    }

    fn message(&self) -> String {
        match self {
            Self::Failed(error) => error.message.clone(),
            Self::Loads(loads) => loads_message(loads),
        }
    }
}

impl From<WireError> for Refusal {
    fn from(error: WireError) -> Self {
        Self::Failed(error)
    }
}

impl Supervisor {
    pub(super) async fn switch(&self, reason: &str, setups: Setups) -> Result<(), WireError> {
        let _turn = self.take_turn().await;
        self.run_switch(reason, setups).await
    }

    pub(super) async fn run_switch(&self, reason: &str, setups: Setups) -> Result<(), WireError> {
        self.refuse_while_stopping()?;
        self.link().process_change().await.map_err(WireError::new)?;
        let previous = self.announce_switch();
        let candidate = self.spawn_generation().await?;
        self.print(&format!(
            "[marbles] engine generation {candidate} starting: {reason}"
        ));
        let loaded = match self.load_candidate(candidate, previous).await {
            Ok(loaded) => loaded,
            Err(refusal) => {
                self.refuse(candidate, previous, &refusal, false).await;
                return Err(refusal.into_error());
            }
        };
        self.promote(candidate);
        if let Some(previous) = previous {
            self.retire(previous, loaded.identity.clone()).await;
        }
        let started = self.start(candidate, setups).await;
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                self.failed_start(candidate, error.clone()).await;
                return Err(error);
            }
        };
        self.settle_current(candidate, started, &loaded);
        Ok(())
    }

    fn announce_switch(&self) -> Option<u64> {
        let mut state = self.lock();
        state.generations.prune_exited();
        let previous = state.generations.current;
        let previous_hosts = state
            .generations
            .current()
            .map(|generation| generation.hosts.clone())
            .unwrap_or_default();
        let announced: Vec<(String, WorkspaceState)> = state
            .hosted
            .values()
            .filter(|hosted| !hosted.detaching)
            .map(|hosted| {
                let id = hosted.summary.id.clone();
                let next = if previous_hosts.contains(&id) {
                    WorkspaceState::Reloading
                } else {
                    WorkspaceState::Starting
                };
                (id, next)
            })
            .collect();
        for (id, next) in announced {
            self.update(&mut state, &id, next, None, None);
        }
        previous
    }

    async fn load_candidate(
        &self,
        candidate: u64,
        previous: Option<u64>,
    ) -> Result<LoadResult, Refusal> {
        let ready = self.timings().ready_timeout;
        within(
            ready,
            "starting the engine generation",
            self.registered(candidate),
        )
        .await?;
        let reply = within(
            ready,
            "loading the workspaces",
            self.ask(candidate, GenerationMethod::Load, None),
        )
        .await?;
        let loaded: LoadResult = reply_of("the load result", reply)?;
        let mut state = self.lock();
        if let Some(generation) = state.generations.get_mut(candidate) {
            generation.identity = Some(loaded.identity.clone());
        }
        let running = previous.is_some_and(|previous| {
            state.generations.is_current(previous) && state.generations.is_live(previous)
        });
        let failed: Vec<WorkspaceLoadResult> = loaded
            .loads
            .iter()
            .filter(|load| load.error.is_some())
            .cloned()
            .collect();
        if running && !failed.is_empty() {
            return Err(Refusal::Loads(failed));
        }
        Ok(loaded)
    }

    async fn registered(&self, candidate: u64) -> Result<(), WireError> {
        self.settle(|state| match state.generations.get(candidate) {
            Some(generation) if generation.channel.is_some() => Some(Ok(())),
            _ => state
                .generations
                .exit_reason(candidate)
                .map(|why| Err(WireError::new(why))),
        })
        .await
    }

    fn promote(&self, candidate: u64) {
        let mut state = self.lock();
        state.generations.current = Some(candidate);
        if let Some(generation) = state.generations.get_mut(candidate) {
            generation.role = GenerationRole::Current;
        }
        drop(state);
        self.changed();
    }

    async fn retire(&self, previous: u64, successor: ProcessIdentity) {
        if let Some(generation) = self.lock().generations.get_mut(previous) {
            generation.role = GenerationRole::Retiring;
        }
        self.changed();
        let retired = within(
            self.timings().stop_timeout,
            &format!("retiring engine generation {previous}"),
            self.ask(
                previous,
                GenerationMethod::Retire,
                params_of(&RetireParams { successor }),
            ),
        )
        .await;
        if let Err(error) = retired {
            if self.lock().orphaned {
                return;
            }
            self.print(&format!("[marbles] {}; stopping it", error.message));
            self.stop_generation(previous).await;
        }
    }

    async fn start(&self, candidate: u64, setups: Setups) -> Result<StartResult, WireError> {
        let reply = within(
            self.timings().ready_timeout,
            "starting the workspaces",
            self.ask(
                candidate,
                GenerationMethod::Start,
                params_of(&StartParams {
                    setups: Some(setups),
                }),
            ),
        )
        .await?;
        reply_of("the start result", reply)
    }

    async fn failed_start(&self, candidate: u64, error: WireError) {
        let replacing = {
            let mut state = self.lock();
            if let Some(generation) = state.generations.get_mut(candidate) {
                generation.start_settled = true;
            }
            let replacing = state.generations.is_current(candidate);
            if replacing {
                state.generations.current = None;
            }
            replacing
        };
        self.changed();
        self.refuse(candidate, None, &Refusal::Failed(error), true)
            .await;
        if replacing {
            let mut state = self.lock();
            self.replace_current(&mut state, "the engine generation did not start", None);
        }
    }

    fn settle_current(&self, candidate: u64, started: StartResult, loaded: &LoadResult) {
        let mut state = self.lock();
        let still_current = match state.generations.get_mut(candidate) {
            Some(generation) => {
                generation.became_current_at = Some(Instant::now());
                generation.is_live()
            }
            None => false,
        } && state.generations.is_current(candidate);
        if !still_current {
            return;
        }
        let failed_loads = loaded.loads.iter().filter(|load| load.error.is_some());
        let shown: Vec<WorkspaceLoadResult> =
            started.loads.iter().chain(failed_loads).cloned().collect();
        self.show_loads(&mut state, candidate, &shown);
        if let Some(generation) = state.generations.get_mut(candidate) {
            generation.start_settled = true;
        }
        self.print(&format!(
            "[marbles] engine generation {candidate} is current"
        ));
        if started.loads.iter().any(|load| load.error.is_some()) {
            self.replace_current(&mut state, "a workspace's engine did not start", None);
        }
        drop(state);
        self.changed();
    }

    fn show_loads(&self, state: &mut State, number: u64, loads: &[WorkspaceLoadResult]) {
        let pid = state
            .generations
            .get(number)
            .and_then(|generation| generation.shown_pid());
        for load in loads {
            let Some(id) = state.loaded_id(load) else {
                continue;
            };
            let Some(hosted) = state.hosted.get_mut(&id) else {
                continue;
            };
            match &load.error {
                None => {
                    hosted.setup = None;
                    if let Some(generation) = state.generations.get_mut(number) {
                        generation.hosts.insert(id.clone());
                    }
                    self.update(state, &id, WorkspaceState::Ready, None, pid);
                }
                Some(error) => {
                    self.update(
                        state,
                        &id,
                        WorkspaceState::Failed,
                        Some(error.clone()),
                        None,
                    );
                }
            }
        }
    }

    async fn refuse(
        &self,
        candidate: u64,
        previous: Option<u64>,
        refusal: &Refusal,
        host_lost: bool,
    ) {
        let why = refusal.message();
        self.print(&format!(
            "[marbles] engine generation {candidate} did not take over: {why}"
        ));
        {
            let mut state = self.lock();
            let previous_hosts: BTreeSet<String> = previous
                .and_then(|previous| state.generations.get(previous))
                .map(|generation| generation.hosts.clone())
                .unwrap_or_default();
            let failures: Option<HashMap<String, Option<String>>> = match refusal {
                Refusal::Loads(loads) => Some(
                    loads
                        .iter()
                        .filter_map(|load| Some((state.loaded_id(load)?, load.error.clone())))
                        .collect(),
                ),
                Refusal::Failed(_) => None,
            };
            let ids: Vec<String> = state.hosted.keys().cloned().collect();
            for id in ids {
                let own = match &failures {
                    Some(failures) => failures.get(&id).cloned().flatten(),
                    None => Some(why.clone()),
                };
                let hosted_before = previous_hosts.contains(&id);
                self.tell_refused(&mut state, &id, hosted_before, own, &why, host_lost);
            }
        }
        self.stop_generation(candidate).await;
    }

    fn tell_refused(
        &self,
        state: &mut State,
        id: &str,
        hosted_before: bool,
        own: Option<String>,
        why: &str,
        host_lost: bool,
    ) {
        let Some(current) = state.hosted.get(id).map(|hosted| hosted.summary.state) else {
            return;
        };
        if hosted_before {
            match own {
                None => self.update(state, id, WorkspaceState::Ready, None, None),
                Some(own) => {
                    let said =
                        format!("a change did not load, so the previous load still runs: {own}");
                    self.update(state, id, WorkspaceState::Ready, Some(said.clone()), None);
                    self.forward_line(Some(id.to_owned()), said);
                }
            }
            return;
        }
        let affected = if host_lost {
            current != WorkspaceState::Stopped
        } else {
            matches!(
                current,
                WorkspaceState::Starting | WorkspaceState::Reloading
            )
        };
        if affected {
            let error = own.unwrap_or_else(|| why.to_owned());
            self.update(state, id, WorkspaceState::Failed, Some(error), None);
        }
    }

    pub(super) fn replace_current(
        &self,
        state: &mut State,
        reason: &str,
        died_current_since: Option<Instant>,
    ) {
        let timings = *self.timings();
        if died_current_since.is_some_and(|since| since.elapsed() >= timings.stable) {
            state.replace_delay = timings.replace_min;
        }
        let delay = state.replace_delay;
        state.replace_delay = (delay * 2).min(timings.replace_max);
        self.print(&format!(
            "[marbles] {reason}; the next engine generation starts in {}ms",
            delay.as_millis()
        ));
        self.schedule_switch(state, reason, delay);
    }

    fn schedule_switch(&self, state: &mut State, reason: &str, delay: Duration) {
        if state.stopping {
            return;
        }
        if let Some(pending) = state.replacement.take() {
            pending.abort();
        }
        let this = self.clone();
        let reason = reason.to_owned();
        state.replacement = Some(tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            tokio::spawn(async move {
                if let Err(error) = this.switch(&reason, Setups::new()).await {
                    this.print(&format!("[marbles] no switch: {}", error.message));
                }
            });
        }));
    }
}

fn loads_message(loads: &[WorkspaceLoadResult]) -> String {
    loads
        .iter()
        .map(|load| {
            load.error
                .clone()
                .unwrap_or_else(|| format!("the workspace at {} did not load", load.root))
        })
        .collect::<Vec<_>>()
        .join("; ")
}
