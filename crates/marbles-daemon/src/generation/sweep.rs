use std::collections::{HashMap, HashSet};

use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::supervisor::{Supervisor, params_of, reply_of, within};
use crate::identity::{ProcessIdentity, is_gone, may_be_same_process};
use crate::protocol::{GenerationMethod, HandedParams, QueuedParams, QueuedTakeResult};
use crate::store::QueuedRun;

pub(super) type RunKey = (String, String);

#[derive(Debug, Default)]
pub(super) struct Sweeping {
    holding_of: Option<u64>,
    held: HashSet<RunKey>,
    pub(super) declined: HashMap<RunKey, Instant>,
    adoptions_declined: HashMap<RunKey, Instant>,
    adoptions_reported: HashSet<RunKey>,
    taking: HashSet<RunKey>,
}

impl Sweeping {
    pub(super) fn hold(&mut self, target: u64, key: RunKey) {
        if self.holding_of == Some(target) {
            self.held.insert(key);
        }
    }
}

impl Supervisor {
    pub(crate) async fn sweep_now(&self) {
        let _gate = self.sweep_gate().lock().await;
        self.sweep_guarded().await;
    }

    pub(crate) fn sweep_tick(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            if let Ok(_gate) = this.sweep_gate().try_lock() {
                this.sweep_guarded().await;
            }
        });
    }

    async fn sweep_guarded(&self) {
        if self.lock().stopping {
            return;
        }
        self.end_gone_generations().await;
        self.sweep(None, false).await;
    }

    async fn end_gone_generations(&self) {
        let Ok(gone) = self.store().end_gone_generations().await else {
            return;
        };
        for number in gone {
            self.print(&format!(
                "[marbles] engine generation {number} is gone, and recorded exited"
            ));
        }
    }

    pub(super) async fn sweep(&self, ids: Option<Vec<String>>, now: bool) {
        let Some((target, identity, ids)) = self.sweep_target(ids) else {
            return;
        };
        let mut offers: Vec<JoinHandle<()>> = Vec::new();
        for id in ids {
            let Ok(queued) = self.store().queued_runs(&id).await else {
                continue;
            };
            let this = self.clone();
            let (offered, owner) = (id.clone(), identity.clone());
            let runs = queued.clone();
            offers.push(tokio::spawn(async move {
                this.adopt_queued(target, owner.as_ref(), &offered, &runs)
                    .await;
            }));
            let handed = self.handed_untaken(&id, identity.as_ref(), queued, now);
            offers.extend(handed.into_iter().filter_map(|run_id| {
                self.offer_handed(HandedParams {
                    id: id.clone(),
                    run_id,
                })
            }));
        }
        for offer in offers {
            let _ = offer.await;
        }
    }

    fn handed_untaken(
        &self,
        id: &str,
        identity: Option<&ProcessIdentity>,
        queued: Vec<QueuedRun>,
        now: bool,
    ) -> Vec<String> {
        let Some(identity) = identity else {
            return Vec::new();
        };
        let reoffer = self.timings().reoffer;
        let state = self.lock();
        let sweeping = &state.sweeping;
        queued
            .into_iter()
            .filter(|run| may_be_same_process(&run.owner, identity))
            .map(|run| run.id)
            .filter(|run_id| {
                let key = (id.to_owned(), run_id.clone());
                let resting = sweeping
                    .declined
                    .get(&key)
                    .is_some_and(|at| at.elapsed() < reoffer);
                !sweeping.held.contains(&key) && (now || !resting)
            })
            .collect()
    }

    fn sweep_target(
        &self,
        ids: Option<Vec<String>>,
    ) -> Option<(u64, Option<ProcessIdentity>, Vec<String>)> {
        let mut state = self.lock();
        if state.stopping {
            return None;
        }
        let target = state.generations.current?;
        if state.sweeping.holding_of != Some(target) {
            state.sweeping.holding_of = Some(target);
            state.sweeping.held.clear();
        }
        let generation = state.generations.get(target)?;
        let ids = ids.unwrap_or_else(|| generation.hosts.iter().cloned().collect());
        Some((target, generation.identity.clone(), ids))
    }

    async fn adopt_queued(
        &self,
        target: u64,
        identity: Option<&ProcessIdentity>,
        id: &str,
        queued: &[QueuedRun],
    ) {
        let mut judged: HashMap<ProcessIdentity, bool> = HashMap::new();
        for run in queued {
            if identity.is_some_and(|identity| may_be_same_process(&run.owner, identity)) {
                continue;
            }
            let gone = match judged.get(&run.owner) {
                Some(&gone) => gone,
                None => {
                    let owner = run.owner.clone();
                    let gone = tokio::task::spawn_blocking(move || is_gone(&owner))
                        .await
                        .unwrap_or(false);
                    judged.insert(run.owner.clone(), gone);
                    gone
                }
            };
            if gone && self.lock().generations.is_current(target) {
                self.offer_adoption(target, id, run).await;
            }
        }
    }

    async fn offer_adoption(&self, target: u64, id: &str, run: &QueuedRun) {
        let key = (id.to_owned(), run.id.clone());
        let reoffer = self.timings().reoffer;
        {
            let mut state = self.lock();
            let sweeping = &mut state.sweeping;
            let resting = sweeping
                .adoptions_declined
                .get(&key)
                .is_some_and(|at| at.elapsed() < reoffer);
            if resting || !sweeping.taking.insert(key.clone()) {
                return;
            }
        }
        let params = QueuedParams {
            id: id.to_owned(),
            owner: run.owner.clone(),
            run_id: run.id.clone(),
        };
        let asked = within(
            self.timings().held_wait,
            &format!("taking queued run {}", run.id),
            self.ask(target, GenerationMethod::TakeQueued, params_of(&params)),
        )
        .await
        .and_then(|reply| reply_of::<QueuedTakeResult>("the queued take", reply));
        let mut state = self.lock();
        let sweeping = &mut state.sweeping;
        sweeping.taking.remove(&key);
        let why = match asked {
            Ok(QueuedTakeResult::Taken) => {
                sweeping.adoptions_declined.remove(&key);
                sweeping.adoptions_reported.remove(&key);
                return;
            }
            Ok(QueuedTakeResult::Declined { why }) => why,
            Err(error) => error.message,
        };
        sweeping
            .adoptions_declined
            .insert(key.clone(), Instant::now());
        if sweeping.adoptions_reported.insert(key) {
            drop(state);
            self.print(&format!(
                "[{id}] queued run {} of gone process pid {} left queued: {why}; offered again every {} s",
                run.id,
                run.owner.pid,
                reoffer.as_secs()
            ));
        }
    }
}
