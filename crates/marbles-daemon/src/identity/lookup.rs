use std::collections::HashMap;

use super::ListedProcess;

pub(super) trait ProcessLookup {
    fn alive(&self, pid: u32) -> bool;
    fn list(&self, pids: &[u32]) -> Option<HashMap<u32, ListedProcess>>;
}

pub(super) struct SystemLookup;

impl ProcessLookup for SystemLookup {
    fn alive(&self, pid: u32) -> bool {
        super::pid_exists(pid)
    }

    fn list(&self, pids: &[u32]) -> Option<HashMap<u32, ListedProcess>> {
        list_processes(pids)
    }
}

pub fn list_processes(pids: &[u32]) -> Option<HashMap<u32, ListedProcess>> {
    if pids.is_empty() {
        return Some(HashMap::new());
    }
    platform::list(pids)
}

#[cfg(target_os = "linux")]
mod platform {
    use std::collections::HashMap;
    use std::fs;
    use std::sync::OnceLock;

    use super::super::ListedProcess;
    use super::super::proc_stat::parse_proc_listing;

    const BOOT_ID_PATH: &str = "/proc/sys/kernel/random/boot_id";

    static BOOT_ID: OnceLock<String> = OnceLock::new();

    pub(super) fn list(pids: &[u32]) -> Option<HashMap<u32, ListedProcess>> {
        let boot = boot_id()?;
        parse_proc_listing(
            pids,
            |pid| fs::read_to_string(format!("/proc/{pid}/stat")),
            boot,
        )
    }

    fn boot_id() -> Option<&'static str> {
        if let Some(boot) = BOOT_ID.get() {
            return Some(boot);
        }
        let boot = fs::read_to_string(BOOT_ID_PATH).ok()?.trim().to_owned();
        Some(BOOT_ID.get_or_init(|| boot))
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use std::collections::HashMap;
    use std::io::Read;
    use std::process::{Child, Command, ExitStatus, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::super::ListedProcess;
    use super::super::ps::parse_ps_listing;

    const PS_COLUMNS: &str = "pid=,pgid=,state=,lstart=";
    const PS_TIMEOUT: Duration = Duration::from_secs(5);
    const PS_POLL: Duration = Duration::from_millis(5);
    const NONE_LISTED: i32 = 1;

    pub(super) fn list(pids: &[u32]) -> Option<HashMap<u32, ListedProcess>> {
        let listed: Vec<String> = pids.iter().map(u32::to_string).collect();
        let mut child = Command::new("ps")
            .args(["-o", PS_COLUMNS, "-p", &listed.join(",")])
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut stdout = child.stdout.take()?;
        let reader = thread::spawn(move || {
            let mut output = String::new();
            stdout.read_to_string(&mut output).map(|_| output)
        });
        let status = wait_with_deadline(&mut child, Instant::now() + PS_TIMEOUT);
        let output = reader.join().ok()?.ok()?;
        status
            .filter(|status| matches!(status.code(), Some(0 | NONE_LISTED)))
            .and_then(|_| parse_ps_listing(&output))
    }

    fn wait_with_deadline(child: &mut Child, deadline: Instant) -> Option<ExitStatus> {
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(PS_POLL),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::this_process;

    #[test]
    fn looking_up_nothing_needs_no_system_call() {
        assert_eq!(list_processes(&[]), Some(HashMap::new()));
    }

    #[test]
    fn the_running_test_process_is_listed_with_a_start() {
        let pid = std::process::id();
        let seen = list_processes(&[pid]).expect("the system should list this process");
        let own = seen.get(&pid).expect("this process should be listed");

        assert!(!own.exited);
        assert_eq!(Some(own.started.clone()), this_process().started);
    }

    #[test]
    fn an_unused_pid_is_simply_absent() {
        let seen = list_processes(&[u32::MAX / 2]).expect("an absent pid is not a lookup failure");

        assert!(seen.is_empty());
    }
}
