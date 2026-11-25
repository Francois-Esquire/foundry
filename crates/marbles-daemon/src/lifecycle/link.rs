use tokio::sync::{mpsc, oneshot};

use super::ProcessChangeError;
use super::actor::{Command, DaemonEvent};
use crate::generation::{DaemonLink, ProcessChange, Publication};

pub(super) struct LifecycleLink {
    pub(super) events: mpsc::Sender<DaemonEvent>,
    pub(super) publications: mpsc::UnboundedSender<Publication>,
}

impl DaemonLink for LifecycleLink {
    fn publish(&self, publication: Publication) {
        let _ = self.publications.send(publication);
    }

    fn process_change(&self) -> ProcessChange<'_> {
        Box::pin(async move {
            let (reply, answered) = oneshot::channel();
            let asked = self
                .events
                .send(DaemonEvent::Command(Command::ProcessChange(reply)))
                .await;
            let outcome = match asked {
                Ok(()) => answered.await.unwrap_or(Err(ProcessChangeError::Stopping)),
                Err(_) => Err(ProcessChangeError::Stopping),
            };
            outcome.map_err(|error| error.to_string())
        })
    }
}
