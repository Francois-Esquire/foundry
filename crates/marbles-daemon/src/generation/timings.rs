use std::time::Duration;

use crate::protocol::GENERATION_STOP_TIMEOUT;
#[cfg(test)]
use crate::protocol::ReadNotificationParams;

pub const SOURCE_POLL_INTERVAL: Duration = Duration::from_secs(1);
pub const SWITCH_DEBOUNCE: Duration = Duration::from_millis(500);
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(2);
pub const REOFFER_INTERVAL: Duration = Duration::from_secs(30);

#[cfg(test)]
pub trait ReadObserver: Send + Sync + 'static {
    fn read(&self, generation: u64, read: &ReadNotificationParams);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimingConfig {
    pub ready_timeout: Duration,
    pub stop_timeout: Duration,
    pub replace_min: Duration,
    pub replace_max: Duration,
    pub stable: Duration,
    pub handover_attempts: u32,
    pub handover_retry: Duration,
    pub held_wait: Duration,
    pub live_work_wait: Duration,
    pub source_poll: Duration,
    pub switch_debounce: Duration,
    pub sweep: Duration,
    pub reoffer: Duration,
}

impl Default for TimingConfig {
    fn default() -> Self {
        Self {
            ready_timeout: Duration::from_secs(120),
            stop_timeout: GENERATION_STOP_TIMEOUT,
            replace_min: Duration::from_secs(1),
            replace_max: Duration::from_secs(30),
            stable: Duration::from_secs(30),
            handover_attempts: 5,
            handover_retry: Duration::from_millis(200),
            held_wait: Duration::from_secs(30),
            live_work_wait: Duration::from_secs(2),
            source_poll: SOURCE_POLL_INTERVAL,
            switch_debounce: SWITCH_DEBOUNCE,
            sweep: SWEEP_INTERVAL,
            reoffer: REOFFER_INTERVAL,
        }
    }
}
