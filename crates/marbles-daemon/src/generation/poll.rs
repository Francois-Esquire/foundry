use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};

use tokio::time::Instant;

use super::supervisor::Supervisor;
use super::switch::Setups;
use crate::fingerprint::{
    FileDigests, Fingerprint, INSTALLATION_POLL_INTERVAL, TREE_LIMIT, WorkspacePrint,
    WorkspaceRegistration, installation_digest, print_now,
};
use crate::protocol::{ReadNotificationParams, WireError};
use crate::store::StoredWorkspace;

const SOURCE_CHANGED: &str = "a source or the installation changed";

#[derive(Debug, Default)]
pub(super) struct Watching {
    pub(super) refused: Option<Fingerprint>,
    digests: Arc<Mutex<FileDigests>>,
    installation: Option<(String, Instant)>,
}

pub(super) fn registration_of(workspace: &StoredWorkspace) -> WorkspaceRegistration {
    WorkspaceRegistration {
        id: workspace.id.clone(),
        root: workspace.root.clone(),
        config: workspace.config.clone(),
    }
}

fn changed_lines(was: &Fingerprint, now: &Fingerprint) -> Vec<String> {
    now.sources
        .keys()
        .filter(|id| was.sources.contains_key(*id) && was.edited(now, id))
        .map(|id| format!("[{id}] source changed · reloading"))
        .collect()
}

fn outside_reads(against: Option<&Fingerprint>) -> BTreeMap<String, Vec<String>> {
    against
        .map(|against| {
            against
                .sources
                .iter()
                .map(|(id, print)| (id.clone(), print.outside.keys().cloned().collect()))
                .collect()
        })
        .unwrap_or_default()
}

struct ReadInFlight {
    supervisor: Supervisor,
    number: u64,
}

impl Drop for ReadInFlight {
    fn drop(&mut self) {
        if let Some(generation) = self.supervisor.lock().generations.get_mut(self.number) {
            generation.in_flight_reads = generation.in_flight_reads.saturating_sub(1);
        }
        self.supervisor.changed();
    }
}

impl Supervisor {
    pub(super) async fn with_digests<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut FileDigests) -> T + Send + 'static,
    ) -> Result<T, WireError> {
        let digests = Arc::clone(&self.lock().watching.digests);
        tokio::task::spawn_blocking(move || {
            let mut digests = digests.lock().unwrap_or_else(PoisonError::into_inner);
            work(&mut digests)
        })
        .await
        .map_err(|error| WireError::new(format!("reading the sources failed: {error}")))
    }

    pub(super) async fn print_of(
        &self,
        registration: WorkspaceRegistration,
    ) -> Result<WorkspacePrint, WireError> {
        let ignored = self.ignored();
        self.with_digests(move |digests| {
            print_now(&registration, [], digests, &ignored, TREE_LIMIT)
        })
        .await
    }

    pub(super) async fn fingerprint_now(
        &self,
        against: Option<&Fingerprint>,
        refresh_installation: bool,
    ) -> Result<Fingerprint, WireError> {
        let registered = self
            .store()
            .list_hosted_workspaces()
            .await
            .map_err(|error| WireError::new(error.to_string()))?;
        let outside = outside_reads(against);
        let cached = self.cached_installation(refresh_installation);
        let (root, version) = self.installation();
        let ignored = self.ignored();
        let (fingerprint, refreshed) = self
            .with_digests(move |digests| {
                let refreshed = cached
                    .is_none()
                    .then(|| installation_digest(root.as_deref(), &version));
                let installation = cached.or_else(|| refreshed.clone()).unwrap_or_default();
                let sources = registered
                    .iter()
                    .map(|workspace| {
                        let read = outside.get(&workspace.id).into_iter().flatten();
                        let print = print_now(
                            &registration_of(workspace),
                            read,
                            digests,
                            &ignored,
                            TREE_LIMIT,
                        );
                        (workspace.id.clone(), print)
                    })
                    .collect();
                (Fingerprint::of(&installation, sources), refreshed)
            })
            .await?;
        if let Some(refreshed) = refreshed {
            self.lock().watching.installation = Some((refreshed, Instant::now()));
        }
        Ok(fingerprint)
    }

    fn cached_installation(&self, refresh: bool) -> Option<String> {
        self.lock()
            .watching
            .installation
            .clone()
            .filter(|(_, at)| !refresh && at.elapsed() < INSTALLATION_POLL_INTERVAL)
            .map(|(digest, _)| digest)
    }

    async fn unchanged(&self, fingerprint: &Fingerprint) -> Result<bool, WireError> {
        Ok(self.fingerprint_now(Some(fingerprint), false).await?.digest == fingerprint.digest)
    }

    pub(super) async fn wanted(&self) -> Result<bool, WireError> {
        let current = self
            .lock()
            .generations
            .current()
            .map(|generation| generation.fingerprint.clone());
        if let Some(current) = current {
            if self.unchanged(&current).await? {
                return Ok(false);
            }
        }
        Ok(!self.refused_unchanged().await?)
    }

    async fn refused_unchanged(&self) -> Result<bool, WireError> {
        let refused = self.lock().watching.refused.clone();
        match refused {
            Some(refused) => self.unchanged(&refused).await,
            None => Ok(false),
        }
    }

    pub(crate) async fn poll_now(&self) -> bool {
        let _gate = self.poll_gate().lock().await;
        self.poll_guarded().await
    }

    pub(crate) fn poll_tick(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            if let Ok(_gate) = this.poll_gate().try_lock() {
                this.poll_guarded().await;
            }
        });
    }

    async fn poll_guarded(&self) -> bool {
        {
            let state = self.lock();
            if state.stopping || state.switching || state.switch_pending {
                return false;
            }
        }
        let _ = self.poll_once().await;
        true
    }

    async fn poll_once(&self) -> Result<(), WireError> {
        let (target, against) = {
            let state = self.lock();
            if state.switching || (state.generations.current.is_none() && state.hosted.is_empty()) {
                return Ok(());
            }
            let against = state
                .generations
                .current()
                .map(|generation| generation.fingerprint.clone());
            (state.generations.current, against)
        };
        let now = match &against {
            Some(against) => Some(self.fingerprint_now(Some(against), false).await?),
            None => None,
        };
        let same =
            matches!((&against, &now), (Some(against), Some(now)) if now.digest == against.digest);
        if same {
            return Ok(());
        }
        if self.refused_unchanged().await? {
            return Ok(());
        }
        let said = {
            let mut state = self.lock();
            if state.switching || state.generations.current != target {
                return Ok(());
            }
            let debounce = self.timings().switch_debounce;
            self.schedule_switch(&mut state, SOURCE_CHANGED, debounce, false);
            match (&against, &now) {
                (Some(was), Some(now)) => changed_lines(was, now),
                _ => Vec::new(),
            }
        };
        for line in said {
            self.print(&line);
        }
        Ok(())
    }

    pub(super) fn read_by(&self, number: u64, read: ReadNotificationParams) {
        if let Some(generation) = self.lock().generations.get_mut(number) {
            generation.in_flight_reads += 1;
        }
        let this = self.clone();
        tokio::spawn(async move {
            let _recording = ReadInFlight {
                supervisor: this.clone(),
                number,
            };
            let _ = this.record_read(number, read).await;
        });
    }

    async fn record_read(
        &self,
        number: u64,
        read: ReadNotificationParams,
    ) -> Result<(), WireError> {
        let found = {
            let state = self.lock();
            state.id_at(&read.root).and_then(|id| {
                let print = state
                    .generations
                    .get(number)?
                    .fingerprint
                    .sources
                    .get(&id)?
                    .clone();
                state.hosted.contains_key(&id).then_some((id, print))
            })
        };
        let Some((id, print)) = found else {
            return Ok(());
        };
        let file = read.file.clone();
        let digest = self
            .with_digests(move |digests| print.read_digest(&file, read.read_at, digests))
            .await?;
        let Some(digest) = digest else {
            return Ok(());
        };
        let mut state = self.lock();
        let Some(generation) = state.generations.get_mut(number) else {
            return Ok(());
        };
        if let Some(print) = generation.fingerprint.sources.get(&id) {
            let next = print.with_outside(&read.file, digest);
            generation.fingerprint = generation.fingerprint.with_source(&id, Some(next));
        }
        Ok(())
    }

    pub(crate) async fn switch_scheduled(
        &self,
        reason: &str,
        forced: bool,
    ) -> Result<(), WireError> {
        let _turn = self.take_turn().await;
        self.refuse_while_stopping()?;
        if !forced && !self.wanted().await? {
            return Ok(());
        }
        self.run_switch(reason, Setups::new()).await
    }
}
