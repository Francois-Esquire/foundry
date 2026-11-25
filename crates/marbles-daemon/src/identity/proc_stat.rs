use std::collections::HashMap;
use std::io;

use super::ListedProcess;
use super::starts::{LINUX_KIND, is_digits, is_exited_state};

const STAT_STATE: usize = 0;
const STAT_PGID: usize = 2;
const STAT_START: usize = 19;
const BOOT_ID_GROUPS: [usize; 5] = [8, 4, 4, 4, 12];

pub(super) fn parse_proc_listing(
    pids: &[u32],
    read: impl Fn(u32) -> io::Result<String>,
    boot_id: &str,
) -> Option<HashMap<u32, ListedProcess>> {
    let mut seen = HashMap::new();
    for &pid in pids {
        match read(pid) {
            Ok(stat) => {
                seen.insert(pid, parse_proc_stat(&stat, boot_id)?);
            }
            Err(error) if is_unlisted(&error) => {}
            Err(_) => return None,
        }
    }
    Some(seen)
}

fn parse_proc_stat(stat: &str, boot_id: &str) -> Option<ListedProcess> {
    let (_, after_name) = stat.rsplit_once(')')?;
    let fields: Vec<&str> = after_name.trim().split(' ').collect();
    let state = fields.get(STAT_STATE).copied().unwrap_or_default();
    let pgid = fields.get(STAT_PGID)?.parse().ok()?;
    let ticks = fields
        .get(STAT_START)
        .copied()
        .filter(|ticks| is_digits(ticks))?;
    let boot = boot_id.trim();
    if !is_proc_state(state) || !is_boot_id(boot) {
        return None;
    }
    Some(ListedProcess {
        exited: is_exited_state(state),
        pgid,
        started: format!("{LINUX_KIND}{boot}:{ticks}"),
    })
}

fn is_unlisted(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
    ) || error.raw_os_error() == Some(rustix::io::Errno::SRCH.raw_os_error())
}

fn is_proc_state(state: &str) -> bool {
    state.len() == 1 && state.bytes().all(|byte| byte.is_ascii_alphabetic())
}

fn is_boot_id(boot: &str) -> bool {
    let groups: Vec<&str> = boot.split('-').collect();
    groups.len() == BOOT_ID_GROUPS.len()
        && groups.iter().zip(BOOT_ID_GROUPS).all(|(group, length)| {
            group.len() == length
                && group
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOT: &str = "0f6c1e7a-3b2d-4c5e-8f90-a1b2c3d4e5f6";

    fn proc_stat(name: &str, state: &str) -> String {
        format!(
            "1234 ({name}) {state} 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10"
        )
    }

    #[test]
    fn proc_stat_reads_pgid_and_boot_scoped_ticks() {
        let seen = parse_proc_stat(&proc_stat("node", "S"), &format!("{BOOT}\n"));

        assert_eq!(
            seen,
            Some(ListedProcess {
                exited: false,
                pgid: 1234,
                started: format!("linux:{BOOT}:987654"),
            })
        );
    }

    #[test]
    fn proc_stat_survives_parentheses_and_spaces_in_the_name() {
        let seen =
            parse_proc_stat(&proc_stat("we) ird (name", "Z"), BOOT).expect("the stat should parse");

        assert!(seen.exited);
        assert_eq!(seen.started, format!("linux:{BOOT}:987654"));
    }

    #[test]
    fn proc_stat_rejects_malformed_input() {
        assert_eq!(parse_proc_stat("1234 node S 1", BOOT), None);
        assert_eq!(parse_proc_stat(&proc_stat("node", "SS"), BOOT), None);
        assert_eq!(
            parse_proc_stat(&proc_stat("node", "S"), "not-a-boot-id"),
            None
        );
        assert_eq!(parse_proc_stat("1234 (node) S 1 1234", BOOT), None);
    }

    #[test]
    fn proc_listing_skips_vanished_processes_and_fails_on_other_errors() {
        let read = |pid: u32| match pid {
            1 => Ok(proc_stat("init", "S")),
            2 => Err(io::Error::from(io::ErrorKind::NotFound)),
            3 => Err(io::Error::from_raw_os_error(
                rustix::io::Errno::SRCH.raw_os_error(),
            )),
            _ => Err(io::Error::other("disk on fire")),
        };

        let seen = parse_proc_listing(&[1, 2, 3], read, BOOT).expect("the listing should parse");
        assert_eq!(seen.len(), 1);
        assert!(seen.contains_key(&1));
        assert_eq!(parse_proc_listing(&[1, 4], read, BOOT), None);
    }
}
