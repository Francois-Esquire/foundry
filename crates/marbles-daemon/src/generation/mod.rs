mod attach;
mod dispatch;
mod generations;
mod handover;
mod hosted;
mod launcher;
mod link;
mod output;
mod poll;
mod records;
mod subprocess;
mod supervisor;
mod sweep;
mod switch;
mod teardown;
#[cfg(test)]
mod tests;
mod timings;
mod workspace;

pub(crate) use self::dispatch::SupervisedRequest;
pub use self::generations::GenerationRole;
pub use self::launcher::{GenerationExit, GenerationLauncher, SpawnSpec, SpawnedGeneration};
pub(crate) use self::link::{DaemonLink, ProcessChange, Publication};
pub use self::subprocess::{
    SPAWN_RECORD_ENV, SPAWN_RECOVERY_ENV, STDERR_TAIL, StdioMode, SubprocessLauncher,
};
pub(crate) use self::supervisor::{Supervisor, SupervisorParts};
#[cfg(test)]
pub use self::timings::ReadObserver;
pub use self::timings::{
    REOFFER_INTERVAL, SOURCE_POLL_INTERVAL, SWEEP_INTERVAL, SWITCH_DEBOUNCE, TimingConfig,
};
