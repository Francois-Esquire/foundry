use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::Value;
use tokio::sync::oneshot;

use super::ChannelError;

pub(super) type Outcome = Result<Option<Value>, ChannelError>;

#[derive(Debug, Default)]
pub(super) struct Pending {
    state: Mutex<State>,
}

#[derive(Debug, Default)]
struct State {
    closed: bool,
    next_id: u64,
    waiting: HashMap<u64, oneshot::Sender<Outcome>>,
}

impl Pending {
    pub(super) fn register(
        &self,
        queue: impl FnOnce(u64) -> bool,
    ) -> Option<oneshot::Receiver<Outcome>> {
        let mut state = self.lock();
        if state.closed {
            return None;
        }
        let id = state.next_id;
        state.next_id += 1;
        let (answer, answered) = oneshot::channel();
        state.waiting.insert(id, answer);
        if !queue(id) {
            state.waiting.remove(&id);
            return None;
        }
        Some(answered)
    }

    pub(super) fn settle(&self, id: u64, outcome: Outcome) {
        let waiter = self.lock().waiting.remove(&id);
        if let Some(waiter) = waiter {
            let _ = waiter.send(outcome);
        }
    }

    pub(super) fn close(&self) -> bool {
        let (first, waiting) = {
            let mut state = self.lock();
            let first = !std::mem::replace(&mut state.closed, true);
            (first, std::mem::take(&mut state.waiting))
        };
        for waiter in waiting.into_values() {
            let _ = waiter.send(Err(ChannelError::Closed));
        }
        first
    }

    pub(super) fn is_closed(&self) -> bool {
        self.lock().closed
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
