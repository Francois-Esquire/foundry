use serde_json::Value;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::supervisor::{Supervisor, params_of, within};
use crate::protocol::{GenerationMethod, HandedParams};

enum Offered {
    Taken(u64),
    Declined,
    Moved,
}

impl Supervisor {
    pub(super) fn handed(&self, handed: HandedParams) {
        let _ = self.offer_handed(handed);
    }

    pub(super) fn offer_handed(&self, handed: HandedParams) -> Option<JoinHandle<()>> {
        let key = (handed.id.clone(), handed.run_id.clone());
        if !self.lock().offering.insert(key.clone()) {
            return None;
        }
        self.changed();
        let this = self.clone();
        Some(tokio::spawn(async move {
            let offered = this.hand_over(&handed).await;
            let mut state = this.lock();
            state.offering.remove(&key);
            match offered {
                Offered::Taken(target) => {
                    state.sweeping.declined.remove(&key);
                    state.sweeping.hold(target, key);
                }
                Offered::Declined => {
                    state.sweeping.declined.insert(key, Instant::now());
                }
                Offered::Moved => {}
            }
            drop(state);
            this.changed();
        }))
    }

    pub(super) async fn handovers_settled(&self, id: &str) {
        self.settle(|state| {
            (!state.offering.iter().any(|(workspace, _)| workspace == id)).then_some(())
        })
        .await;
    }

    async fn hand_over(&self, handed: &HandedParams) -> Offered {
        let timings = *self.timings();
        let HandedParams { id, run_id } = handed;
        for _ in 0..timings.handover_attempts {
            let Some(target) = self.lock().generations.current else {
                return Offered::Moved;
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
                return Offered::Moved;
            }
            let taken = within(
                timings.held_wait,
                &format!("taking handed run {run_id}"),
                self.ask(target, GenerationMethod::TakeHanded, params_of(handed)),
            )
            .await;
            match taken {
                Ok(Some(Value::Bool(true))) => return Offered::Taken(target),
                Ok(_) => {}
                Err(error) => {
                    self.print(&format!(
                        "[{id}] run {run_id} not taken over: {}",
                        error.message
                    ));
                    break;
                }
            }
            self.next_change(timings.handover_retry).await;
        }
        Offered::Declined
    }
}
