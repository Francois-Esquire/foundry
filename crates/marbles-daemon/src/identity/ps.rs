use std::collections::HashMap;
use std::ops::RangeInclusive;

use super::ListedProcess;
use super::starts::{PS_KIND, collapse_spaces, is_digits, is_exited_state};

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

pub(super) fn parse_ps_listing(listed: &str) -> Option<HashMap<u32, ListedProcess>> {
    listed
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_ps_line)
        .collect()
}

fn parse_ps_line(line: &str) -> Option<(u32, ListedProcess)> {
    let (pid, rest) = next_field(line)?;
    let (pgid, rest) = next_field(rest)?;
    let (state, rest) = next_field(rest)?;
    let lstart = collapse_spaces(rest);
    if !is_digits(pid) || !is_digits(pgid) || !is_ps_state(state) || !is_lstart(&lstart) {
        return None;
    }
    Some((
        pid.parse().ok()?,
        ListedProcess {
            exited: is_exited_state(state),
            pgid: pgid.parse().ok()?,
            started: format!("{PS_KIND}{lstart}"),
        },
    ))
}

fn next_field(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    let end = text.find(char::is_whitespace)?;
    Some((&text[..end], &text[end..]))
}

fn is_ps_state(state: &str) -> bool {
    let mut bytes = state.bytes();
    let leads = bytes
        .next()
        .is_some_and(|first| first.is_ascii_uppercase() || first == b'?');
    leads && bytes.all(|byte| byte.is_ascii_alphabetic() || matches!(byte, b'<' | b'>' | b'+'))
}

fn is_lstart(lstart: &str) -> bool {
    let parts: Vec<&str> = lstart.split(' ').collect();
    let [weekday, month, day, clock, year] = parts.as_slice() else {
        return false;
    };
    WEEKDAYS.contains(weekday)
        && MONTHS.contains(month)
        && is_bounded(day, 1, 2, 1..=31)
        && is_clock(clock)
        && year.len() == 4
        && is_digits(year)
}

fn is_clock(clock: &str) -> bool {
    let parts: Vec<&str> = clock.split(':').collect();
    let [hours, minutes, seconds] = parts.as_slice() else {
        return false;
    };
    is_bounded(hours, 2, 2, 0..=23)
        && is_bounded(minutes, 2, 2, 0..=59)
        && is_bounded(seconds, 2, 2, 0..=60)
}

fn is_bounded(text: &str, shortest: usize, longest: usize, range: RangeInclusive<u32>) -> bool {
    (shortest..=longest).contains(&text.len())
        && is_digits(text)
        && text.parse().is_ok_and(|value| range.contains(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_line_normalises_lstart() {
        let parsed = parse_ps_line(" 68792 68790 Ss   Wed Nov  5 09:46:24 2026    ");

        assert_eq!(
            parsed,
            Some((
                68792,
                ListedProcess {
                    exited: false,
                    pgid: 68790,
                    started: "ps:Wed Nov 5 09:46:24 2026".to_owned(),
                }
            ))
        );
    }

    #[test]
    fn ps_line_marks_zombies_exited() {
        let (_, seen) =
            parse_ps_line("7 7 Z+ Fri Nov 20 14:59:19 2026").expect("the line should parse");

        assert!(seen.exited);
    }

    #[test]
    fn ps_line_rejects_bad_states_and_dates() {
        assert_eq!(parse_ps_line("7 7 s Fri Nov 20 14:59:19 2026"), None);
        assert_eq!(parse_ps_line("7 7 S Fri Nov 32 14:59:19 2026"), None);
        assert_eq!(parse_ps_line("7 7 S Fri Nov 20 24:59:19 2026"), None);
        assert_eq!(parse_ps_line("7 7 S Fri Nov 20 14:59:19"), None);
        assert_eq!(parse_ps_line("7 7 S Fri Abc 20 14:59:19 2026"), None);
        assert_eq!(parse_ps_line("x 7 S Fri Nov 20 14:59:19 2026"), None);
    }

    #[test]
    fn ps_listing_skips_blank_lines_and_fails_on_any_bad_line() {
        let listed =
            "  1     1 Ss   Fri Nov 20 14:59:19 2026\n\n 42    40 R+   Wed Nov 25 09:46:24 2026\n";
        let seen = parse_ps_listing(listed).expect("the listing should parse");

        assert_eq!(seen.len(), 2);
        assert_eq!(seen.get(&42).map(|seen| seen.pgid), Some(40));
        assert_eq!(parse_ps_listing("1 1 Ss garbage"), None);
        assert_eq!(parse_ps_listing(""), Some(HashMap::new()));
    }
}
