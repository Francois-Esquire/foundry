use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use crate::identity::ProcessIdentity;
use crate::protocol::{GENERATION_STOP_TIMEOUT, ReadNotificationParams};

pub type OwnerLookup<'a> = Pin<Box<dyn Future<Output = Option<ProcessIdentity>> + Send + 'a>>;

pub trait RunOwnerResolver: Send + Sync + 'static {
    fn owner_of(&self, workspace_id: &str, run_id: &str) -> OwnerLookup<'_>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoRunOwnerResolver;

impl RunOwnerResolver for NoRunOwnerResolver {
    fn owner_of(&self, _workspace_id: &str, _run_id: &str) -> OwnerLookup<'_> {
        Box::pin(async { None })
    }
}

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
        }
    }
}
