use crate::channel::ChannelError;
use crate::identity::{ProcessSignal, SignalRefusal, signal_proven};
use crate::protocol::{GenerationMethod, WireError, WorkspaceState};

use super::supervisor::{Supervisor, within};

impl Supervisor {
    pub(crate) async fn shutdown(&self) {
        let live = {
            let mut state = self.lock();
            state.stopping = true;
            if let Some(pending) = state.switch_timer.take() {
                pending.abort();
            }
            state.records.cancel();
            state.generations.live()
        };
        self.changed();
        let stopping: Vec<_> = live
            .into_iter()
            .map(|number| {
                let this = self.clone();
                tokio::spawn(async move { this.stop_generation(number).await })
            })
            .collect();
        for stop in stopping {
            let _ = stop.await;
        }
        let mut state = self.lock();
        let ids: Vec<String> = state.hosted.keys().cloned().collect();
        for id in ids {
            self.update(&mut state, &id, WorkspaceState::Stopped, None, None);
        }
    }

    pub(crate) fn release_for_recycle(&self) {
        let channels = {
            let mut state = self.lock();
            state.stopping = true;
            state.released_for_recycle = true;
            if let Some(pending) = state.switch_timer.take() {
                pending.abort();
            }
            state.records.cancel();
            state.generations.channels()
        };
        for channel in channels {
            channel.close();
        }
        self.changed();
    }

    pub(super) async fn stop_generation(&self, number: u64) {
        let channel = {
            let state = self.lock();
            match state.generations.get(number) {
                Some(generation) if generation.is_live() && !state.released_for_recycle => {
                    generation.open_channel()
                }
                _ => return,
            }
        };
        let stop_timeout = self.timings().stop_timeout;
        let stopped = async {
            match channel {
                Some(channel) => {
                    within(
                        stop_timeout,
                        &format!("stopping engine generation {number}"),
                        async {
                            tokio::select! {
                                answered = channel.request(GenerationMethod::Stop, None) => match answered {
                                    Err(ChannelError::Remote(error)) => Err(error),
                                    Ok(_) | Err(ChannelError::Closed) => Ok(()),
                                },
                                _ = self.exit_of(number) => Ok(()),
                            }
                        },
                    )
                    .await?;
                }
                None => {
                    if !self.signal(number, ProcessSignal::Term).await {
                        return Ok(());
                    }
                }
            }
            within(
                stop_timeout,
                &format!("engine generation {number}'s exit"),
                async {
                    self.exit_of(number).await;
                    Ok(())
                },
            )
            .await
        };
        let stopped: Result<(), WireError> = stopped.await;
        if let Err(error) = stopped {
            self.print(&format!("[marbles] {}; killing it", error.message));
            if self.signal(number, ProcessSignal::Kill).await {
                let _ = tokio::time::timeout(stop_timeout, self.exit_of(number)).await;
            }
        }
    }

    async fn signal(&self, number: u64, signal: ProcessSignal) -> bool {
        let known = {
            let state = self.lock();
            match state.generations.get(number) {
                Some(generation) if generation.is_live() && !state.released_for_recycle => {
                    generation.provable_identity()
                }
                _ => return false,
            }
        };
        let name = match signal {
            ProcessSignal::Term => "SIGTERM",
            ProcessSignal::Kill => "SIGKILL",
        };
        let label = format!("[marbles] engine generation {number} is not sent {name}");
        let Some(known) = known.filter(|known| known.started.is_some()) else {
            self.print(&format!(
                "{label}: its start was never read, so its pid cannot be proved to be it"
            ));
            return false;
        };
        let pid = known.pid;
        let sent = tokio::task::spawn_blocking(move || signal_proven(&known, signal)).await;
        match sent {
            Ok(Ok(())) => true,
            Ok(Err(SignalRefusal::LookupFailed)) => {
                self.print(&format!(
                    "{label}: the system cannot say what runs as pid {pid}"
                ));
                false
            }
            Ok(Err(SignalRefusal::PidReused)) => {
                self.print(&format!("{label}: pid {pid} is another process now"));
                false
            }
            Ok(Err(SignalRefusal::StartUnknown)) => {
                self.print(&format!(
                    "{label}: its start was never read, so its pid cannot be proved to be it"
                ));
                false
            }
            Ok(Err(
                SignalRefusal::NotRunning
                | SignalRefusal::Unsignalable
                | SignalRefusal::SendFailed(_),
            ))
            | Err(_) => false,
        }
    }
}
