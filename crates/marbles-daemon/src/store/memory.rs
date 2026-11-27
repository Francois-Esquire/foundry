use super::runs::state_of_run;
use super::storage::{GenerationChange, GenerationRow, Storage};
use super::{GenerationRecord, GenerationState, StoreError, StoredWorkspace};
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub(super) struct MemoryStorage {
    workspaces: BTreeMap<String, StoredWorkspace>,
    generations: BTreeMap<u64, GenerationRecord>,
    runs: BTreeMap<(String, String), String>,
    hosting_failures: usize,
    state_failure: Option<(GenerationState, usize)>,
}

impl Storage for MemoryStorage {
    fn hosted_workspaces(&mut self) -> Result<Vec<StoredWorkspace>, StoreError> {
        Ok(self
            .workspaces
            .values()
            .filter(|workspace| workspace.hosted)
            .cloned()
            .collect())
    }

    fn workspace(&mut self, id: &str) -> Result<Option<StoredWorkspace>, StoreError> {
        Ok(self.workspaces.get(id).cloned())
    }

    fn touch_workspace(
        &mut self,
        workspace: &StoredWorkspace,
        _at: &str,
    ) -> Result<(), StoreError> {
        self.workspaces
            .insert(workspace.id.clone(), workspace.clone());
        Ok(())
    }

    fn unhost_workspace(&mut self, id: &str) -> Result<bool, StoreError> {
        Ok(match self.workspaces.get_mut(id) {
            Some(workspace) if workspace.hosted => {
                workspace.hosted = false;
                true
            }
            _ => false,
        })
    }

    fn insert_generation(&mut self, fingerprint: &str, _at: &str) -> Result<u64, StoreError> {
        let number = self
            .generations
            .keys()
            .next_back()
            .map_or(1, |last| last + 1);
        self.generations.insert(
            number,
            GenerationRecord {
                number,
                fingerprint: fingerprint.to_owned(),
                pid: 0,
                started: None,
                state: GenerationState::Loading,
                error: None,
                workspaces: Vec::new(),
            },
        );
        Ok(number)
    }

    fn update_generation(
        &mut self,
        number: u64,
        change: &GenerationChange,
        _at: &str,
    ) -> Result<(), StoreError> {
        if matches!(change, GenerationChange::Hosting(_)) && self.hosting_failures > 0 {
            self.hosting_failures -= 1;
            return Err(StoreError::failed("the disk is full"));
        }
        if let GenerationChange::State { state, .. } = change {
            if let Some((failing, left)) = self.state_failure.as_mut() {
                if failing == state && *left > 0 {
                    *left -= 1;
                    return Err(StoreError::failed("the disk is full"));
                }
            }
        }
        let Some(generation) = self.generations.get_mut(&number) else {
            return Ok(());
        };
        match change {
            GenerationChange::Spawned { pid, started } => {
                generation.pid = i64::from(*pid);
                generation.started.clone_from(started);
            }
            GenerationChange::Identified { pid, started } => {
                generation.pid = i64::from(*pid);
                generation.started.clone_from(started);
            }
            GenerationChange::Hosting(workspaces) => generation.workspaces.clone_from(workspaces),
            GenerationChange::State { state, error } => {
                generation.state = *state;
                if error.is_some() {
                    generation.error.clone_from(error);
                }
            }
        }
        Ok(())
    }

    fn generation(&mut self, number: u64) -> Result<Option<GenerationRecord>, StoreError> {
        Ok(self.generations.get(&number).cloned())
    }

    fn generations_in(
        &mut self,
        states: &[GenerationState],
    ) -> Result<Vec<GenerationRow>, StoreError> {
        Ok(self
            .generations
            .iter()
            .filter(|(_, generation)| states.contains(&generation.state))
            .map(|(&number, generation)| GenerationRow {
                number,
                pid: generation.pid,
                started: generation.started.clone(),
            })
            .collect())
    }

    fn queued_bodies(&mut self, scope: &str) -> Result<Vec<String>, StoreError> {
        Ok(self
            .runs
            .iter()
            .filter(|((run_scope, _), body)| {
                run_scope == scope && state_of_run(body).as_deref() == Some("queued")
            })
            .map(|(_, body)| body.clone())
            .collect())
    }

    fn run_body(&mut self, scope: &str, run_id: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .runs
            .get(&(scope.to_owned(), run_id.to_owned()))
            .cloned())
    }

    fn put_run(&mut self, scope: &str, id: &str, body: &str) -> Result<(), StoreError> {
        self.runs
            .insert((scope.to_owned(), id.to_owned()), body.to_owned());
        Ok(())
    }

    #[cfg(test)]
    fn fail_hosting(&mut self, times: usize) {
        self.hosting_failures = times;
    }

    #[cfg(test)]
    fn fail_state(&mut self, state: GenerationState, times: usize) {
        self.state_failure = Some((state, times));
    }
}
