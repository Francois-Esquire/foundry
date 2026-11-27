use std::collections::BTreeSet;
use std::time::Duration;

use tokio::task::JoinHandle;

use super::generations::GenerationRole;
use super::supervisor::Supervisor;
use crate::store::GenerationState;

#[derive(Debug)]
pub(super) struct HostRecords {
    hosts_due: BTreeSet<u64>,
    current_due: BTreeSet<u64>,
    delay: Duration,
    retry: Option<JoinHandle<()>>,
}

impl HostRecords {
    pub(super) fn new(delay: Duration) -> Self {
        Self {
            hosts_due: BTreeSet::new(),
            current_due: BTreeSet::new(),
            delay,
            retry: None,
        }
    }

    pub(super) fn cancel(&mut self) {
        if let Some(retry) = self.retry.take() {
            retry.abort();
        }
    }
}

enum Due {
    Skip,
    Write { current: bool, hosts: Vec<String> },
}

impl Supervisor {
    pub(super) async fn mark_current(&self, number: u64) {
        let marked = self
            .store()
            .mark_generation(number, GenerationState::Current, None)
            .await;
        if let Err(error) = marked {
            self.print(&format!(
                "[marbles] engine generation {number} was not recorded current: {error}; it is written again with the workspaces it hosts"
            ));
            self.lock().records.current_due.insert(number);
        }
    }

    pub(super) async fn record_hosts(&self, number: u64) {
        self.lock().records.hosts_due.insert(number);
        self.write_hosts_due().await;
    }

    async fn write_hosts_due(&self) {
        let _gate = self.hosts_gate().lock().await;
        let due: Vec<u64> = std::mem::take(&mut self.lock().records.hosts_due)
            .into_iter()
            .collect();
        for number in due {
            let (current, hosts) = match self.due(number) {
                Due::Skip => continue,
                Due::Write { current, hosts } => (current, hosts),
            };
            let written = async {
                if current {
                    self.store()
                        .mark_generation(number, GenerationState::Current, None)
                        .await?;
                    self.lock().records.current_due.remove(&number);
                }
                self.store().record_generation_hosting(number, &hosts).await
            };
            if let Err(error) = written.await {
                self.print(&format!(
                    "[marbles] which workspaces engine generation {number} hosts was not recorded: {error}; it is written again after a backoff"
                ));
                self.lock().records.hosts_due.insert(number);
            }
        }
        self.schedule_hosts_retry();
    }

    fn due(&self, number: u64) -> Due {
        let mut state = self.lock();
        let stopping = state.stopping;
        let hosts = state
            .generations
            .get(number)
            .filter(|generation| {
                !stopping && generation.role != GenerationRole::Retiring && generation.is_live()
            })
            .map(|generation| generation.hosts.iter().cloned().collect());
        match hosts {
            Some(hosts) => Due::Write {
                current: state.records.current_due.contains(&number),
                hosts,
            },
            None => {
                state.records.current_due.remove(&number);
                Due::Skip
            }
        }
    }

    fn schedule_hosts_retry(&self) {
        let timings = *self.timings();
        let mut state = self.lock();
        if state.records.hosts_due.is_empty() {
            state.records.cancel();
            state.records.delay = timings.replace_min;
            return;
        }
        let waiting = state
            .records
            .retry
            .as_ref()
            .is_some_and(|retry| !retry.is_finished());
        if waiting || state.stopping {
            return;
        }
        let delay = state.records.delay;
        state.records.delay = (delay * 2).min(timings.replace_max);
        let this = self.clone();
        state.records.retry = Some(tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            tokio::spawn(async move { this.write_hosts_due().await });
        }));
    }
}
