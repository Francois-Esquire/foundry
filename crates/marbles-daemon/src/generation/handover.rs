use serde_json::Value;

use super::supervisor::{Supervisor, params_of, within};
use crate::protocol::{GenerationMethod, HandedParams};

impl Supervisor {
    pub(super) fn handed(&self, handed: HandedParams) {
        let key = (handed.id.clone(), handed.run_id.clone());
        if !self.lock().offering.insert(key.clone()) {
            return;
        }
        self.changed();
        let this = self.clone();
        tokio::spawn(async move {
            this.hand_over(&handed).await;
            this.lock().offering.remove(&key);
            this.changed();
        });
    }

    pub(super) async fn handovers_settled(&self, id: &str) {
        self.settle(|state| {
            (!state.offering.iter().any(|(workspace, _)| workspace == id)).then_some(())
        })
        .await;
    }

    async fn hand_over(&self, handed: &HandedParams) {
        let timings = *self.timings();
        let HandedParams { id, run_id } = handed;
        for _ in 0..timings.handover_attempts {
            let Some(target) = self.lock().generations.current else {
                return;
            };
            self.settle(|state| state.generations.start_settled(target).then_some(()))
                .await;
            let hosting = {
                let state = self.lock();
                state.generations.is_current(target)
                    && state
                        .generations
                        .get(target)
                        .is_some_and(|generation| generation.hosts.contains(id))
            };
            if !hosting {
                return;
            }
            let taken = within(
                timings.held_wait,
                &format!("taking handed run {run_id}"),
                self.ask(target, GenerationMethod::TakeHanded, params_of(handed)),
            )
            .await;
            match taken {
                Ok(Some(Value::Bool(true))) => return,
                Ok(_) => {}
                Err(error) => {
                    self.print(&format!(
                        "[{id}] run {run_id} not taken over: {}",
                        error.message
                    ));
                    return;
                }
            }
            self.next_change(timings.handover_retry).await;
        }
    }
}
