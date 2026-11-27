use std::io;

use rustix::process::{Pid, Signal, kill_process, kill_process_group};

use super::ProcessIdentity;
use super::lookup::{ProcessLookup, SystemLookup};
use super::starts::{StartComparison, compare_starts};

const LOWEST_SIGNALABLE_PID: i32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessSignal {
    Term,
    Kill,
}

#[derive(Debug)]
pub enum SignalRefusal {
    StartUnknown,
    LookupFailed,
    NotRunning,
    PidReused,
    Unsignalable,
    SendFailed(io::Error),
}

pub fn signal_proven(known: &ProcessIdentity, signal: ProcessSignal) -> Result<(), SignalRefusal> {
    prove(known, &SystemLookup)?.send(signal)
}

struct Target {
    pid: Pid,
    leads_group: bool,
}

impl Target {
    fn send(self, signal: ProcessSignal) -> Result<(), SignalRefusal> {
        let signal = match signal {
            ProcessSignal::Term => Signal::TERM,
            ProcessSignal::Kill => Signal::KILL,
        };
        let sent = if self.leads_group {
            kill_process_group(self.pid, signal)
        } else {
            kill_process(self.pid, signal)
        };
        sent.map_err(|error| SignalRefusal::SendFailed(error.into()))
    }
}

fn prove(known: &ProcessIdentity, lookup: &impl ProcessLookup) -> Result<Target, SignalRefusal> {
    let Some(started) = known.started.as_deref() else {
        return Err(SignalRefusal::StartUnknown);
    };
    let pid = i32::try_from(known.pid)
        .ok()
        .filter(|&pid| pid >= LOWEST_SIGNALABLE_PID)
        .and_then(Pid::from_raw)
        .ok_or(SignalRefusal::Unsignalable)?;
    let seen = lookup
        .list(&[known.pid])
        .ok_or(SignalRefusal::LookupFailed)?;
    let running = seen.get(&known.pid).ok_or(SignalRefusal::NotRunning)?;
    if compare_starts(Some(&running.started), Some(started)) != StartComparison::Same {
        return Err(SignalRefusal::PidReused);
    }
    Ok(Target {
        pid,
        leads_group: running.pgid == known.pid,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Child, Command};

    use super::super::{ListedProcess, read_start};
    use super::*;

    const PID: u32 = 4242;
    const START: &str = "ps:Wed Nov 25 09:46:24 2026";

    struct Listing(Option<HashMap<u32, ListedProcess>>);

    impl ProcessLookup for Listing {
        fn alive(&self, _: u32) -> bool {
            true
        }

        fn list(&self, _: &[u32]) -> Option<HashMap<u32, ListedProcess>> {
            self.0.clone()
        }
    }

    fn known(pid: u32, started: Option<&str>) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            started: started.map(str::to_owned),
        }
    }

    fn listing(started: &str) -> Listing {
        Listing(Some(HashMap::from([(
            PID,
            ListedProcess {
                exited: false,
                pgid: PID,
                started: started.to_owned(),
            },
        )])))
    }

    fn sleeper(own_group: bool) -> Child {
        let mut command = Command::new("sleep");
        command.arg("30");
        if own_group {
            command.process_group(0);
        }
        command.spawn().expect("sleep should spawn")
    }

    fn identity_of(child: &Child) -> ProcessIdentity {
        known(child.id(), read_start(child.id()).known().as_deref())
    }

    #[test]
    fn an_unread_start_is_never_signalled() {
        let refusal = prove(&known(PID, None), &listing(START)).err();

        assert!(matches!(refusal, Some(SignalRefusal::StartUnknown)));
    }

    #[test]
    fn init_and_pid_zero_are_never_signalled() {
        assert!(matches!(
            prove(&known(1, Some(START)), &listing(START)).err(),
            Some(SignalRefusal::Unsignalable)
        ));
        assert!(matches!(
            prove(&known(0, Some(START)), &listing(START)).err(),
            Some(SignalRefusal::Unsignalable)
        ));
    }

    #[test]
    fn an_unreadable_system_refuses_the_signal() {
        let refusal = prove(&known(PID, Some(START)), &Listing(None)).err();

        assert!(matches!(refusal, Some(SignalRefusal::LookupFailed)));
    }

    #[test]
    fn an_unlisted_pid_is_not_running() {
        let refusal = prove(&known(PID, Some(START)), &Listing(Some(HashMap::new()))).err();

        assert!(matches!(refusal, Some(SignalRefusal::NotRunning)));
    }

    #[test]
    fn a_reused_pid_is_not_signalled() {
        let refusal = prove(
            &known(PID, Some(START)),
            &listing("ps:Wed Nov 25 10:00:00 2026"),
        )
        .err();

        assert!(matches!(refusal, Some(SignalRefusal::PidReused)));
    }

    #[test]
    fn a_proven_child_is_terminated() {
        let mut child = sleeper(false);
        let outcome = signal_proven(&identity_of(&child), ProcessSignal::Term);
        let status = child.wait().expect("the child should be reaped");

        assert!(outcome.is_ok());
        assert_eq!(status.signal(), Some(Signal::TERM.as_raw()));
    }

    #[test]
    fn a_group_leader_is_signalled_through_its_group() {
        let mut child = sleeper(true);
        let identity = identity_of(&child);
        let target = prove(&identity, &SystemLookup).expect("the child should be proved");
        let leads_group = target.leads_group;
        let outcome = target.send(ProcessSignal::Kill);
        let status = child.wait().expect("the child should be reaped");

        assert!(leads_group);
        assert!(outcome.is_ok());
        assert_eq!(status.signal(), Some(Signal::KILL.as_raw()));
    }
}
