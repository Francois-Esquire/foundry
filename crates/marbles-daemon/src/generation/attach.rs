use std::path::{Path, PathBuf};

use super::dispatch::{id_params, setups_for, unhosted};
use super::hosted::Hosted;
use super::link::Publication;
use super::supervisor::{Supervisor, params_of, reply_of, within};
use super::workspace::{Placement, locate};
use crate::fingerprint::{WorkspacePrint, WorkspaceRegistration};
use crate::protocol::{
    AttachParams, GenerationMethod, HostParams, HostResult, SetupDraftParams, WireError,
    WorkspaceState, WorkspaceSummary,
};
use crate::store::{StoreError, StoredWorkspace, inside_state};

const DEFAULT_SOURCE: &str = ".foundry/marbles";

enum DetachStart {
    Absent,
    Pending,
    Begun(Vec<u64>, Option<(u64, WorkspacePrint)>),
}

fn wire(error: StoreError) -> WireError {
    WireError::new(error.to_string())
}

pub(super) fn placement_of(stored: &StoredWorkspace) -> Placement {
    let root = stored.root.display().to_string();
    let config = stored
        .config
        .as_ref()
        .map(|config| config.display().to_string());
    let source = config
        .clone()
        .unwrap_or_else(|| stored.root.join(DEFAULT_SOURCE).display().to_string());
    Placement {
        id: stored.id.clone(),
        root,
        config,
        source,
    }
}

fn registration_of(placement: &Placement) -> WorkspaceRegistration {
    WorkspaceRegistration {
        id: placement.id.clone(),
        root: PathBuf::from(&placement.root),
        config: placement.config.as_ref().map(PathBuf::from),
    }
}

impl Supervisor {
    pub(super) async fn attach(&self, params: AttachParams) -> Result<WorkspaceSummary, WireError> {
        let source = params.source.as_str().to_owned();
        let root = params.root.as_ref().map(|root| root.as_str().to_owned());
        let placement = tokio::task::spawn_blocking(move || locate(&source, root.as_deref()))
            .await
            .map_err(|error| WireError::new(format!("locating the workspace failed: {error}")))?
            .map_err(WireError::new)?;
        let setup = params.setup;
        loop {
            let turn = self.take_turn().await;
            self.refuse_while_stopping()?;
            if !self.inside_state_root(&placement.id).await {
                return Err(WireError::new(format!(
                    "the state of workspace {} at {} links out of the state root; it is not hosted",
                    placement.id,
                    self.layout().state.join(&placement.id).display()
                )));
            }
            let existing = self.lock().hosted.get(&placement.id).cloned();
            match existing {
                Some(existing) if existing.detaching => {
                    drop(turn);
                    self.detached(&placement.id).await;
                }
                Some(existing) if existing.summary.state != WorkspaceState::Stopped => {
                    self.ensure_registered(&placement).await?;
                    if let Some(summary) = self
                        .attach_again(&existing, &placement, setup.clone())
                        .await?
                    {
                        return Ok(summary);
                    }
                    return self.host_new(&placement, setup).await;
                }
                _ => return self.host_new(&placement, setup).await,
            }
        }
    }

    async fn inside_state_root(&self, id: &str) -> bool {
        let state = self.layout().state.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || inside_state(&state, &id))
            .await
            .unwrap_or(false)
    }

    async fn touch(&self, placement: &Placement) -> Result<(), StoreError> {
        self.store()
            .touch_workspace(
                &placement.id,
                Path::new(&placement.root),
                placement.config.as_deref().map(Path::new),
                true,
            )
            .await
    }

    async fn ensure_registered(&self, placement: &Placement) -> Result<(), WireError> {
        let registered = self
            .store()
            .read_workspace(&placement.id)
            .await
            .map_err(wire)?;
        if !registered.is_some_and(|registered| registered.hosted) {
            self.touch(placement).await.map_err(wire)?;
        }
        Ok(())
    }

    async fn attach_again(
        &self,
        existing: &Hosted,
        placement: &Placement,
        setup: Option<SetupDraftParams>,
    ) -> Result<Option<WorkspaceSummary>, WireError> {
        let id = &placement.id;
        if existing.source != placement.source {
            return Err(WireError::new(format!(
                "workspace {id} is hosted from {}; detach it first",
                existing.source
            )));
        }
        if setup.is_none() && existing.summary.state != WorkspaceState::Failed {
            return Ok(Some(existing.summary.clone()));
        }
        let hosted_now = self
            .lock()
            .generations
            .current()
            .is_some_and(|current| current.hosts.contains(id));
        if !hosted_now && setup.is_none() {
            return Ok(None);
        }
        self.run_switch(
            &format!("workspace {id} attached again"),
            setups_for(id, setup),
        )
        .await?;
        self.summary_of(id).map(Some)
    }

    async fn host_new(
        &self,
        placement: &Placement,
        setup: Option<SetupDraftParams>,
    ) -> Result<WorkspaceSummary, WireError> {
        let kept = self.register_hosted(placement).await?;
        let entry = Hosted::starting(placement, setup.clone());
        let target = {
            let mut state = self.lock();
            self.link()
                .publish(Publication::Workspace(entry.summary.clone()));
            state.hosted.insert(placement.id.clone(), entry);
            state.generations.current
        };
        let hosted = match target {
            None => self.host_by_switch(placement, setup).await,
            Some(target) => self.host_on(target, placement, setup).await,
        };
        if hosted.is_err() {
            self.unregister(&placement.id, kept).await;
        }
        hosted
    }

    async fn register_hosted(&self, placement: &Placement) -> Result<bool, WireError> {
        let before = self
            .store()
            .read_workspace(&placement.id)
            .await
            .map_err(wire)?;
        self.touch(placement).await.map_err(wire)?;
        Ok(before.is_some_and(|before| before.hosted))
    }

    async fn host_by_switch(
        &self,
        placement: &Placement,
        setup: Option<SetupDraftParams>,
    ) -> Result<WorkspaceSummary, WireError> {
        let id = &placement.id;
        self.run_switch(&format!("workspace {id} attached"), setups_for(id, setup))
            .await?;
        let summary = self.summary_of(id)?;
        if summary.state == WorkspaceState::Failed {
            return Err(WireError::new(
                summary
                    .error
                    .unwrap_or_else(|| "the workspace did not load".to_owned()),
            ));
        }
        Ok(summary)
    }

    async fn host_on(
        &self,
        target: u64,
        placement: &Placement,
        setup: Option<SetupDraftParams>,
    ) -> Result<WorkspaceSummary, WireError> {
        let id = &placement.id;
        let print = self.print_of(registration_of(placement)).await?;
        self.set_print(target, id, Some(print));
        let host = HostParams {
            config: placement.config.clone(),
            root: placement.root.clone(),
            setup,
        };
        let hosted = within(
            self.timings().ready_timeout,
            "starting the workspace",
            self.ask(target, GenerationMethod::Host, params_of(&host)),
        )
        .await
        .and_then(|reply| reply_of::<HostResult>("the host result", reply));
        if let Err(error) = hosted {
            self.set_print(target, id, None);
            let failed = Some(error.message.clone());
            self.update(&mut self.lock(), id, WorkspaceState::Failed, failed, None);
            return Err(error);
        }
        let summary = self.hosted_on(target, id);
        self.record_hosts(target).await;
        summary
    }

    fn hosted_on(&self, target: u64, id: &str) -> Result<WorkspaceSummary, WireError> {
        let mut state = self.lock();
        let pid = state
            .generations
            .get(target)
            .and_then(|generation| generation.shown_pid());
        if let Some(generation) = state.generations.get_mut(target) {
            generation.hosts.insert(id.to_owned());
        }
        if let Some(hosted) = state.hosted.get_mut(id) {
            hosted.setup = None;
        }
        self.update(&mut state, id, WorkspaceState::Ready, None, pid);
        state
            .hosted
            .get(id)
            .map(|hosted| hosted.summary.clone())
            .ok_or_else(|| unhosted(id))
    }

    fn set_print(&self, number: u64, id: &str, print: Option<WorkspacePrint>) {
        if let Some(generation) = self.lock().generations.get_mut(number) {
            generation.fingerprint = generation.fingerprint.with_source(id, print);
        }
    }

    async fn unregister(&self, id: &str, kept: bool) {
        if kept {
            return;
        }
        if self.lock().hosted.remove(id).is_some() {
            self.link().publish(Publication::Withdrawn(id.to_owned()));
        }
        self.changed();
        let _ = self.store().unhost_workspace(id).await;
    }

    async fn detached(&self, id: &str) {
        self.settle(|state| {
            (!state.hosted.get(id).is_some_and(|hosted| hosted.detaching)).then_some(())
        })
        .await;
    }

    pub(super) async fn detach(&self, id: &str) -> Result<(), WireError> {
        let begun = {
            let _turn = self.take_turn().await;
            self.begin_detach(id).await?
        };
        let (hosting, loaded) = match begun {
            DetachStart::Absent => return Ok(()),
            DetachStart::Pending => {
                self.detached(id).await;
                return Ok(());
            }
            DetachStart::Begun(hosting, loaded) => (hosting, loaded),
        };
        let retired = self.retire_everywhere(id, &hosting).await;
        let _turn = self.take_turn().await;
        if let Some(hosted) = self.lock().hosted.get_mut(id) {
            hosted.detaching = false;
        }
        match retired {
            Ok(()) => {
                let mut state = self.lock();
                self.update(&mut state, id, WorkspaceState::Stopped, None, None);
                state.hosted.remove(id);
                self.link().publish(Publication::Withdrawn(id.to_owned()));
            }
            Err(ref error) => self.restore(id, loaded, &error.message).await,
        }
        self.changed();
        retired
    }

    async fn restore(&self, id: &str, loaded: Option<(u64, WorkspacePrint)>, error: &str) {
        if let Some((number, print)) = loaded {
            self.set_print(number, id, Some(print));
        }
        let why = format!("detach failed: {error}");
        let placement = self.lock().hosted.get(id).map(|hosted| Placement {
            id: id.to_owned(),
            root: hosted.summary.root.clone(),
            config: hosted.summary.config.clone(),
            source: hosted.source.clone(),
        });
        let touched = match &placement {
            Some(placement) => self.touch(placement).await,
            None => Ok(()),
        };
        let said = match touched {
            Ok(()) => format!("{why}; attach it again to load it afresh"),
            Err(touch) => format!(
                "{why}; its registration was not put back ({touch}); attach it again to repair it"
            ),
        };
        let mut state = self.lock();
        self.update(&mut state, id, WorkspaceState::Failed, Some(said), None);
    }

    async fn begin_detach(&self, id: &str) -> Result<DetachStart, WireError> {
        match self.lock().hosted.get(id) {
            None => return Ok(DetachStart::Absent),
            Some(hosted) if hosted.detaching => return Ok(DetachStart::Pending),
            Some(_) => {}
        }
        self.store().unhost_workspace(id).await.map_err(wire)?;
        let mut state = self.lock();
        let Some(hosted) = state.hosted.get_mut(id) else {
            return Ok(DetachStart::Absent);
        };
        hosted.detaching = true;
        let loaded = state.generations.current.and_then(|number| {
            let generation = state.generations.get_mut(number)?;
            let print = generation.fingerprint.sources.get(id)?.clone();
            generation.fingerprint = generation.fingerprint.with_source(id, None);
            Some((number, print))
        });
        let hosting = state.generations.hosts_of(id);
        let numbers: Vec<String> = hosting.iter().map(u64::to_string).collect();
        let plural = if hosting.len() == 1 { "" } else { "s" };
        let waiting = format!(
            "detaching: waiting for engine generation{plural} {} to finish its work",
            numbers.join(", ")
        );
        self.update(&mut state, id, WorkspaceState::Stopped, Some(waiting), None);
        Ok(DetachStart::Begun(hosting, loaded))
    }

    async fn retire_everywhere(&self, id: &str, hosting: &[u64]) -> Result<(), WireError> {
        for &number in hosting {
            self.print(&format!(
                "[{id}] detaching · waiting for engine generation {number} to finish its work"
            ));
            let unhosted = self
                .ask(number, GenerationMethod::Unhost, Some(id_params(id)))
                .await;
            if let Err(error) = unhosted {
                let going = {
                    let state = self.lock();
                    state.stopping
                        || state
                            .generations
                            .get(number)
                            .and_then(|generation| generation.open_channel())
                            .is_none()
                };
                if !going {
                    return Err(error);
                }
            }
            if let Some(generation) = self.lock().generations.get_mut(number) {
                generation.hosts.remove(id);
            }
            self.record_hosts(number).await;
        }
        Ok(())
    }

    pub(crate) async fn boot(&self) -> Result<bool, StoreError> {
        self.store().end_all_generations().await?;
        let registered = self.store().list_hosted_workspaces().await?;
        let mut state = self.lock();
        for stored in &registered {
            let entry = Hosted::starting(&placement_of(stored), None);
            self.link()
                .publish(Publication::Workspace(entry.summary.clone()));
            state.hosted.insert(stored.id.clone(), entry);
        }
        Ok(!registered.is_empty())
    }

    pub(crate) fn host_registered(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(error) = this
                .switch("the Marbles process started", Default::default())
                .await
            {
                this.print(&format!("[marbles] not hosted again: {}", error.message));
            }
        });
    }
}
