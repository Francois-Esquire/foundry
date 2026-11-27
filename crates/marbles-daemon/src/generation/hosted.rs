use std::path::Path;

use super::workspace::Placement;
use crate::layout::normalize;
use crate::protocol::{SetupDraftParams, WorkspaceState, WorkspaceSummary};

#[derive(Debug, Clone)]
pub(super) struct Hosted {
    pub(super) source: String,
    pub(super) setup: Option<SetupDraftParams>,
    pub(super) summary: WorkspaceSummary,
    pub(super) detaching: bool,
}

impl Hosted {
    pub(super) fn starting(placement: &Placement, setup: Option<SetupDraftParams>) -> Self {
        Self {
            source: placement.source.clone(),
            setup,
            summary: WorkspaceSummary {
                config: placement.config.clone(),
                error: None,
                id: placement.id.clone(),
                pid: None,
                root: placement.root.clone(),
                state: WorkspaceState::Starting,
            },
            detaching: false,
        }
    }

    pub(super) fn set_state(
        &mut self,
        state: WorkspaceState,
        error: Option<String>,
        pid: Option<u32>,
    ) -> Option<WorkspaceSummary> {
        let pid = pid
            .or(self.summary.pid)
            .filter(|_| state != WorkspaceState::Stopped);
        let next = WorkspaceSummary {
            error,
            pid,
            state,
            ..self.summary.clone()
        };
        if next == self.summary {
            return None;
        }
        self.summary = next.clone();
        Some(next)
    }

    pub(super) fn is_at(&self, root: &str) -> bool {
        normalize(Path::new(&self.summary.root)) == normalize(Path::new(root))
    }

    pub(super) fn described(&self) -> String {
        let state = serde_json::to_value(self.summary.state)
            .ok()
            .and_then(|state| state.as_str().map(str::to_owned))
            .unwrap_or_default();
        match &self.summary.error {
            Some(error) => format!("workspace {} is {state}: {error}", self.summary.id),
            None => format!("workspace {} is {state}", self.summary.id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosted() -> Hosted {
        Hosted::starting(
            &Placement {
                id: "w1".to_owned(),
                root: "/repo".to_owned(),
                config: None,
                source: "/repo/.foundry/marbles".to_owned(),
            },
            None,
        )
    }

    #[test]
    fn a_state_change_keeps_the_pid_and_replaces_the_error() {
        let mut workspace = hosted();

        assert!(
            workspace
                .set_state(WorkspaceState::Failed, Some("broke".to_owned()), Some(7))
                .is_some()
        );
        let ready = workspace.set_state(WorkspaceState::Ready, None, None);

        assert_eq!(ready.as_ref().map(|summary| summary.pid), Some(Some(7)));
        assert_eq!(ready.and_then(|summary| summary.error), None);
        assert_eq!(workspace.set_state(WorkspaceState::Ready, None, None), None);
    }

    #[test]
    fn a_stopped_workspace_has_no_pid() {
        let mut workspace = hosted();
        workspace.set_state(WorkspaceState::Ready, None, Some(7));

        let stopped = workspace.set_state(WorkspaceState::Stopped, None, Some(9));

        assert_eq!(stopped.map(|summary| summary.pid), Some(None));
        assert_eq!(workspace.described(), "workspace w1 is stopped");
    }
}
