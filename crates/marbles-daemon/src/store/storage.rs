use super::{GenerationRecord, GenerationState, StoreError, StoredWorkspace};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenerationChange {
    Spawned {
        pid: u32,
        started: Option<String>,
    },
    Identified {
        pid: u32,
        started: Option<String>,
    },
    Hosting(Vec<String>),
    State {
        state: GenerationState,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationRow {
    pub number: u64,
    pub pid: i64,
    pub started: Option<String>,
}

pub trait Storage: Send + 'static {
    fn hosted_workspaces(&mut self) -> Result<Vec<StoredWorkspace>, StoreError>;
    fn workspace(&mut self, id: &str) -> Result<Option<StoredWorkspace>, StoreError>;
    fn touch_workspace(&mut self, workspace: &StoredWorkspace, at: &str) -> Result<(), StoreError>;
    fn unhost_workspace(&mut self, id: &str) -> Result<bool, StoreError>;
    fn insert_generation(&mut self, fingerprint: &str, at: &str) -> Result<u64, StoreError>;
    fn update_generation(
        &mut self,
        number: u64,
        change: &GenerationChange,
        at: &str,
    ) -> Result<(), StoreError>;
    fn generation(&mut self, number: u64) -> Result<Option<GenerationRecord>, StoreError>;
    fn generations_in(
        &mut self,
        states: &[GenerationState],
    ) -> Result<Vec<GenerationRow>, StoreError>;
    fn queued_bodies(&mut self, scope: &str) -> Result<Vec<String>, StoreError>;
    fn run_body(&mut self, scope: &str, run_id: &str) -> Result<Option<String>, StoreError>;

    fn put_run(&mut self, _scope: &str, _id: &str, _body: &str) -> Result<(), StoreError> {
        Err(StoreError::failed(
            "this storage cannot be seeded with runs",
        ))
    }

    #[cfg(test)]
    fn fail_hosting(&mut self, _times: usize) {}

    #[cfg(test)]
    fn fail_state(&mut self, _state: GenerationState, _times: usize) {}
}
