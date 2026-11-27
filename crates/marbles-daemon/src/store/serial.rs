use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::mpsc;
use std::task::{Context, Poll};
use std::thread;
use std::time::SystemTime;

use serde_json::Value;
use tokio::sync::oneshot;

use super::memory::MemoryStorage;
use super::runs::{owner_of_run, queued_in_order};
use super::sqlite::SqliteStorage;
use super::storage::{GenerationChange, GenerationRow, Storage};
use super::{GenerationRecord, GenerationState, QueuedRun, StoreError, StoredWorkspace};
use crate::Layout;
use crate::identity::{ProcessIdentity, is_gone};
use crate::timestamp::iso_timestamp;

const STORE_THREAD_NAME: &str = "marbles-store";

type Job = Box<dyn FnOnce(&mut dyn Storage) + Send>;

pub struct Stored<T>(Option<oneshot::Receiver<Result<T, StoreError>>>);

impl<T> Future for Stored<T> {
    type Output = Result<T, StoreError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        match self.0.as_mut() {
            None => Poll::Ready(Err(StoreError::Stopped)),
            Some(answer) => Pin::new(answer)
                .poll(context)
                .map(|answered| answered.unwrap_or(Err(StoreError::Stopped))),
        }
    }
}

#[derive(Clone)]
pub struct StateStore {
    jobs: mpsc::Sender<Job>,
    state: Option<PathBuf>,
}

impl StateStore {
    fn spawn(storage: impl Storage, state: Option<PathBuf>) -> Result<Self, StoreError> {
        let (jobs, received) = mpsc::channel::<Job>();
        thread::Builder::new()
            .name(STORE_THREAD_NAME.to_owned())
            .spawn(move || {
                let mut storage = storage;
                for job in received {
                    job(&mut storage);
                }
            })
            .map_err(StoreError::failed)?;
        Ok(Self { jobs, state })
    }

    pub fn in_memory() -> Result<Self, StoreError> {
        Self::spawn(MemoryStorage::default(), None)
    }

    pub fn in_memory_within(state: impl Into<PathBuf>) -> Result<Self, StoreError> {
        Self::spawn(MemoryStorage::default(), Some(state.into()))
    }

    pub fn open_sqlite(layout: &Layout) -> Result<Self, StoreError> {
        Self::spawn(SqliteStorage::open(layout)?, Some(layout.state.clone()))
    }

    pub fn open_existing_sqlite(layout: &Layout) -> Result<Option<Self>, StoreError> {
        match fs::metadata(&layout.database) {
            Ok(_) => Self::open_sqlite(layout).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(StoreError::failed(error)),
        }
    }

    fn call<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut dyn Storage) -> Result<T, StoreError> + Send + 'static,
    ) -> Stored<T> {
        let (reply, answer) = oneshot::channel();
        let queued = self
            .jobs
            .send(Box::new(move |storage| {
                let _ = reply.send(job(storage));
            }))
            .is_ok();
        Stored(queued.then_some(answer))
    }

    fn change(&self, number: u64, change: GenerationChange) -> Stored<()> {
        self.call(move |storage| storage.update_generation(number, &change, &now()))
    }

    pub fn read_generation(&self, number: u64) -> Stored<Option<GenerationRecord>> {
        self.call(move |storage| storage.generation(number))
    }

    pub fn list_hosted_workspaces(&self) -> Stored<Vec<StoredWorkspace>> {
        let state = self.state.clone();
        self.call(move |storage| {
            let hosted = storage.hosted_workspaces()?;
            Ok(hosted
                .into_iter()
                .filter(|workspace| counts(state.as_deref(), &workspace.id))
                .collect())
        })
    }

    pub fn read_workspace(&self, id: &str) -> Stored<Option<StoredWorkspace>> {
        let state = self.state.clone();
        let id = id.to_owned();
        self.call(move |storage| {
            Ok(storage
                .workspace(&id)?
                .filter(|workspace| counts(state.as_deref(), &workspace.id)))
        })
    }

    pub fn touch_workspace(
        &self,
        id: &str,
        root: &Path,
        config: Option<&Path>,
        hosted: bool,
    ) -> Stored<()> {
        let workspace = StoredWorkspace {
            id: id.to_owned(),
            root: root.to_owned(),
            config: config.map(Path::to_owned),
            hosted,
        };
        self.call(move |storage| storage.touch_workspace(&workspace, &now()))
    }

    pub fn unhost_workspace(&self, id: &str) -> Stored<bool> {
        let id = id.to_owned();
        self.call(move |storage| storage.unhost_workspace(&id))
    }

    pub fn begin_generation(&self, fingerprint: &str) -> Stored<u64> {
        let fingerprint = fingerprint.to_owned();
        self.call(move |storage| storage.insert_generation(&fingerprint, &now()))
    }

    pub fn record_generation_spawned(
        &self,
        number: u64,
        pid: u32,
        started: Option<&str>,
    ) -> Stored<()> {
        let started = started.map(str::to_owned);
        self.change(number, GenerationChange::Spawned { pid, started })
    }

    pub fn record_generation_identified(
        &self,
        number: u64,
        pid: u32,
        started: Option<&str>,
    ) -> Stored<()> {
        let started = started.map(str::to_owned);
        self.change(number, GenerationChange::Identified { pid, started })
    }

    pub fn record_generation_hosting(&self, number: u64, workspaces: &[String]) -> Stored<()> {
        let mut workspaces = workspaces.to_vec();
        workspaces.sort();
        self.change(number, GenerationChange::Hosting(workspaces))
    }

    pub fn mark_generation(
        &self,
        number: u64,
        state: GenerationState,
        error: Option<&str>,
    ) -> Stored<()> {
        let error = error.map(str::to_owned);
        self.change(number, GenerationChange::State { state, error })
    }

    pub fn end_all_generations(&self) -> Stored<()> {
        self.call(|storage| {
            let live = storage.generations_in(&GenerationState::LIVE)?;
            for row in live
                .into_iter()
                .filter(|row| row.pid <= 0 || row.started.is_some())
            {
                let state = if proved_gone(&row) {
                    GenerationState::Exited
                } else {
                    GenerationState::Retiring
                };
                let change = GenerationChange::State { state, error: None };
                storage.update_generation(row.number, &change, &now())?;
            }
            Ok(())
        })
    }

    pub fn end_gone_generations(&self) -> Stored<Vec<u64>> {
        self.call(|storage| {
            let retiring = storage.generations_in(&[GenerationState::Retiring])?;
            let gone: Vec<u64> = retiring
                .into_iter()
                .filter(|row| row.pid > 0 && row.started.is_some() && proved_gone(row))
                .map(|row| row.number)
                .collect();
            let exited = GenerationChange::State {
                state: GenerationState::Exited,
                error: None,
            };
            for &number in &gone {
                storage.update_generation(number, &exited, &now())?;
            }
            Ok(gone)
        })
    }

    pub fn read_run_owner(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Stored<Option<ProcessIdentity>> {
        let scope = workspace_id.to_owned();
        let run_id = run_id.to_owned();
        self.call(move |storage| {
            Ok(storage
                .run_body(&scope, &run_id)?
                .as_deref()
                .and_then(owner_of_run))
        })
    }

    pub fn queued_runs(&self, workspace_id: &str) -> Stored<Vec<QueuedRun>> {
        let scope = workspace_id.to_owned();
        self.call(move |storage| Ok(queued_in_order(&storage.queued_bodies(&scope)?)))
    }

    pub fn put_queue_run(&self, scope: &str, body: &Value) -> Stored<()> {
        let scope = scope.to_owned();
        let body = body.clone();
        self.call(move |storage| {
            let id = body
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| StoreError::failed("a queue run needs an id"))?
                .to_owned();
            storage.put_run(&scope, &id, &body.to_string())
        })
    }

    #[cfg(test)]
    pub(crate) fn fail_hosting_records(&self, times: usize) -> Stored<()> {
        self.call(move |storage| {
            storage.fail_hosting(times);
            Ok(())
        })
    }

    #[cfg(test)]
    pub(crate) fn fail_state_records(&self, state: GenerationState, times: usize) -> Stored<()> {
        self.call(move |storage| {
            storage.fail_state(state, times);
            Ok(())
        })
    }
}

fn proved_gone(row: &GenerationRow) -> bool {
    let Ok(pid) = u32::try_from(row.pid) else {
        return true;
    };
    if pid == 0 {
        return true;
    }
    is_gone(&ProcessIdentity {
        pid,
        started: row.started.clone(),
    })
}

fn counts(state: Option<&Path>, id: &str) -> bool {
    state.is_none_or(|state| inside_state(state, id))
}

pub(crate) fn inside_state(state: &Path, id: &str) -> bool {
    let dir = state.join(id);
    let Ok(stat) = fs::symlink_metadata(&dir) else {
        return true;
    };
    if !stat.is_dir() {
        return false;
    }
    match (fs::canonicalize(&dir), fs::canonicalize(state)) {
        (Ok(dir), Ok(state)) => dir == state.join(id),
        _ => false,
    }
}

fn now() -> String {
    iso_timestamp(SystemTime::now())
}
