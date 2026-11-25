mod lookup;
#[cfg(any(target_os = "linux", test))]
mod proc_stat;
#[cfg(any(not(target_os = "linux"), test))]
mod ps;
mod signal;
mod starts;
mod state;

use serde::{Deserialize, Serialize};

pub use lookup::list_processes;
pub use signal::{ProcessSignal, SignalRefusal, signal_proven};
pub use starts::{StartComparison, compare_starts};
pub use state::{
    ProcessStart, ProcessState, is_gone, may_be_same_process, pid_exists, process_state,
    read_start, this_process,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: u32,
    #[serde(deserialize_with = "Option::deserialize")]
    pub started: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedProcess {
    pub exited: bool,
    pub pgid: u32,
    pub started: String,
}
