use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use rustix::io::Errno;
use rustix::process::{Pid, test_kill_process};

use super::ProcessIdentity;
use super::lookup::{ProcessLookup, SystemLookup};
use super::starts::{StartComparison, compare_starts};

const SEEN_FOR: Duration = Duration::from_secs(1);

static OWN_START: OnceLock<String> = OnceLock::new();
static RECENT: RecentStarts = RecentStarts::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Gone,
    Running,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessStart {
    Started(String),
    Gone,
    Unknown,
}

impl ProcessStart {
    pub fn known(self) -> Option<String> {
        match self {
            Self::Started(started) => Some(started),
            Self::Gone | Self::Unknown => None,
        }
    }
}

pub fn this_process() -> ProcessIdentity {
    let pid = std::process::id();
    let started = OWN_START.get().cloned().or_else(|| {
        let started = read_start(pid).known()?;
        Some(OWN_START.get_or_init(|| started).clone())
    });
    ProcessIdentity { pid, started }
}

pub fn pid_exists(pid: u32) -> bool {
    let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) else {
        return false;
    };
    match test_kill_process(pid) {
        Ok(()) => true,
        Err(error) => error == Errno::PERM,
    }
}

pub fn read_start(pid: u32) -> ProcessStart {
    read_start_with(pid, &SystemLookup)
}

pub fn process_state(identity: &ProcessIdentity) -> ProcessState {
    process_state_with(identity, &SystemLookup, &RECENT)
}

pub fn is_gone(identity: &ProcessIdentity) -> bool {
    process_state(identity) == ProcessState::Gone
}

pub fn may_be_same_process(one: &ProcessIdentity, other: &ProcessIdentity) -> bool {
    one.pid == other.pid
        && compare_starts(one.started.as_deref(), other.started.as_deref())
            != StartComparison::Different
}

fn read_start_with(pid: u32, lookup: &impl ProcessLookup) -> ProcessStart {
    let Some(seen) = lookup.list(&[pid]) else {
        return ProcessStart::Unknown;
    };
    match seen.get(&pid) {
        Some(found) if found.exited => ProcessStart::Gone,
        Some(found) => ProcessStart::Started(found.started.clone()),
        None if lookup.alive(pid) => ProcessStart::Unknown,
        None => ProcessStart::Gone,
    }
}

fn process_state_with(
    identity: &ProcessIdentity,
    lookup: &impl ProcessLookup,
    recent: &RecentStarts,
) -> ProcessState {
    if identity.pid == std::process::id() {
        return own_state(identity);
    }
    if !lookup.alive(identity.pid) {
        return ProcessState::Gone;
    }
    let known = identity.started.as_deref();
    if known.is_some_and(|started| recent.confirms(identity.pid, started)) {
        return ProcessState::Running;
    }
    match read_start_with(identity.pid, lookup) {
        ProcessStart::Started(started) => {
            recent.remember(identity.pid, Some(&started));
            match compare_starts(Some(&started), known) {
                StartComparison::Same => ProcessState::Running,
                StartComparison::Different => ProcessState::Gone,
                StartComparison::Unknown => ProcessState::Unknown,
            }
        }
        ProcessStart::Gone => {
            recent.remember(identity.pid, None);
            ProcessState::Gone
        }
        ProcessStart::Unknown => {
            recent.remember(identity.pid, None);
            ProcessState::Unknown
        }
    }
}

fn own_state(identity: &ProcessIdentity) -> ProcessState {
    let own = this_process();
    match compare_starts(identity.started.as_deref(), own.started.as_deref()) {
        StartComparison::Different => ProcessState::Gone,
        StartComparison::Same | StartComparison::Unknown => ProcessState::Running,
    }
}

struct RecentStarts {
    seen: Mutex<Option<HashMap<u32, (Instant, String)>>>,
}

impl RecentStarts {
    const fn new() -> Self {
        Self {
            seen: Mutex::new(None),
        }
    }

    fn confirms(&self, pid: u32, started: &str) -> bool {
        let seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
        seen.as_ref()
            .and_then(|seen| seen.get(&pid))
            .is_some_and(|(at, known)| {
                at.elapsed() < SEEN_FOR
                    && compare_starts(Some(known), Some(started)) == StartComparison::Same
            })
    }

    fn remember(&self, pid: u32, started: Option<&str>) {
        let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
        let seen = seen.get_or_insert_with(HashMap::new);
        match started {
            Some(started) => {
                seen.insert(pid, (Instant::now(), started.to_owned()));
            }
            None => {
                seen.remove(&pid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::super::ListedProcess;
    use super::*;

    const PID: u32 = 4242;
    const START: &str = "ps:Wed Nov 25 09:46:24 2026";
    const LATER: &str = "ps:Wed Nov 25 10:00:00 2026";

    struct FakeLookup {
        alive: bool,
        listed: Option<Option<ListedProcess>>,
        looks: Cell<usize>,
    }

    impl FakeLookup {
        fn new(alive: bool, listed: Option<Option<ListedProcess>>) -> Self {
            Self {
                alive,
                listed,
                looks: Cell::new(0),
            }
        }

        fn running(started: &str) -> Self {
            Self::new(true, Some(Some(seen(started, false))))
        }
    }

    impl ProcessLookup for FakeLookup {
        fn alive(&self, _: u32) -> bool {
            self.alive
        }

        fn list(&self, _: &[u32]) -> Option<HashMap<u32, ListedProcess>> {
            self.looks.set(self.looks.get() + 1);
            self.listed
                .clone()
                .map(|found| found.into_iter().map(|found| (PID, found)).collect())
        }
    }

    fn seen(started: &str, exited: bool) -> ListedProcess {
        ListedProcess {
            exited,
            pgid: PID,
            started: started.to_owned(),
        }
    }

    fn identity(started: Option<&str>) -> ProcessIdentity {
        ProcessIdentity {
            pid: PID,
            started: started.map(str::to_owned),
        }
    }

    #[test]
    fn a_dead_pid_is_gone_without_a_lookup() {
        let lookup = FakeLookup::new(false, None);

        assert_eq!(
            process_state_with(&identity(Some(START)), &lookup, &RecentStarts::new()),
            ProcessState::Gone
        );
        assert_eq!(lookup.looks.get(), 0);
    }

    #[test]
    fn a_matching_start_proves_the_process_runs() {
        let lookup = FakeLookup::running(START);

        assert_eq!(
            process_state_with(&identity(Some(START)), &lookup, &RecentStarts::new()),
            ProcessState::Running
        );
    }

    #[test]
    fn a_different_start_means_the_pid_was_reused() {
        let lookup = FakeLookup::running(LATER);

        assert_eq!(
            process_state_with(&identity(Some(START)), &lookup, &RecentStarts::new()),
            ProcessState::Gone
        );
    }

    #[test]
    fn an_unrecorded_start_cannot_be_proved() {
        let lookup = FakeLookup::running(START);

        assert_eq!(
            process_state_with(&identity(None), &lookup, &RecentStarts::new()),
            ProcessState::Unknown
        );
    }

    #[test]
    fn a_zombie_is_gone() {
        let lookup = FakeLookup::new(true, Some(Some(seen(START, true))));

        assert_eq!(
            process_state_with(&identity(Some(START)), &lookup, &RecentStarts::new()),
            ProcessState::Gone
        );
        assert_eq!(read_start_with(PID, &lookup), ProcessStart::Gone);
    }

    #[test]
    fn a_failed_lookup_is_unknown() {
        let lookup = FakeLookup::new(true, None);

        assert_eq!(
            process_state_with(&identity(Some(START)), &lookup, &RecentStarts::new()),
            ProcessState::Unknown
        );
        assert_eq!(read_start_with(PID, &lookup), ProcessStart::Unknown);
    }

    #[test]
    fn an_unlisted_but_signalable_pid_is_unknown() {
        let lookup = FakeLookup::new(true, Some(None));

        assert_eq!(
            process_state_with(&identity(Some(START)), &lookup, &RecentStarts::new()),
            ProcessState::Unknown
        );
        assert_eq!(read_start_with(PID, &lookup), ProcessStart::Unknown);
    }

    #[test]
    fn an_unlisted_dead_pid_has_no_start() {
        let lookup = FakeLookup::new(false, Some(None));

        assert_eq!(read_start_with(PID, &lookup), ProcessStart::Gone);
    }

    #[test]
    fn a_listed_pid_reports_its_start() {
        let lookup = FakeLookup::running(START);

        assert_eq!(
            read_start_with(PID, &lookup),
            ProcessStart::Started(START.to_owned())
        );
    }

    #[test]
    fn a_recent_confirmation_skips_the_lookup() {
        let recent = RecentStarts::new();
        let lookup = FakeLookup::running(START);

        assert_eq!(
            process_state_with(&identity(Some(START)), &lookup, &recent),
            ProcessState::Running
        );
        assert_eq!(
            process_state_with(&identity(Some(START)), &lookup, &recent),
            ProcessState::Running
        );
        assert_eq!(lookup.looks.get(), 1);
        assert_eq!(
            process_state_with(&identity(Some(LATER)), &lookup, &recent),
            ProcessState::Gone
        );
        assert_eq!(lookup.looks.get(), 2);
    }

    #[test]
    fn a_failed_lookup_forgets_the_recent_confirmation() {
        let recent = RecentStarts::new();
        recent.remember(PID, Some(START));
        recent.remember(PID, None);

        assert!(!recent.confirms(PID, START));
    }

    #[test]
    fn this_process_is_running_unless_its_start_differs() {
        let own = this_process();
        let replaced = ProcessIdentity {
            pid: own.pid,
            started: own.started.as_ref().map(|started| format!("{started}0")),
        };

        assert!(own.started.is_some());
        assert_eq!(process_state(&own), ProcessState::Running);
        assert_eq!(process_state(&replaced), ProcessState::Gone);
        assert!(!is_gone(&ProcessIdentity {
            pid: own.pid,
            started: None
        }));
    }

    #[test]
    fn may_be_same_process_tolerates_unknown_starts() {
        let known = identity(Some(START));

        assert!(may_be_same_process(&known, &identity(None)));
        assert!(may_be_same_process(&known, &identity(Some(START))));
        assert!(!may_be_same_process(&known, &identity(Some(LATER))));
        assert!(!may_be_same_process(
            &known,
            &ProcessIdentity {
                pid: 1,
                started: Some(START.to_owned())
            }
        ));
    }

    #[test]
    fn liveness_follows_the_kernel() {
        assert!(pid_exists(std::process::id()));
        assert!(pid_exists(1));
        assert!(!pid_exists(0));
        assert!(!pid_exists(u32::MAX));
    }
}
