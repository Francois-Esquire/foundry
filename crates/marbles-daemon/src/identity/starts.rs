pub(super) const LINUX_KIND: &str = "linux:";
pub(super) const PS_KIND: &str = "ps:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartComparison {
    Same,
    Different,
    Unknown,
}

pub fn compare_starts(one: Option<&str>, other: Option<&str>) -> StartComparison {
    let (Some(one), Some(other)) = (one, other) else {
        return StartComparison::Unknown;
    };
    if kind_of(one) != kind_of(other) {
        return StartComparison::Unknown;
    }
    if collapse_spaces(one) == collapse_spaces(other) {
        StartComparison::Same
    } else {
        StartComparison::Different
    }
}

pub(super) fn collapse_spaces(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

pub(super) fn is_exited_state(state: &str) -> bool {
    state.starts_with('Z') || state.starts_with('X')
}

fn kind_of(started: &str) -> &'static str {
    if started.starts_with(LINUX_KIND) {
        LINUX_KIND
    } else if started.starts_with(PS_KIND) {
        PS_KIND
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_compare_within_one_kind_only() {
        let ps = Some("ps:Wed Nov 25 09:46:24 2026");

        assert_eq!(
            compare_starts(ps, Some("ps:Wed  Nov 25 09:46:24 2026 ")),
            StartComparison::Same
        );
        assert_eq!(
            compare_starts(ps, Some("ps:Wed Nov 25 09:46:25 2026")),
            StartComparison::Different
        );
        assert_eq!(
            compare_starts(ps, Some("linux:abc:1")),
            StartComparison::Unknown
        );
        assert_eq!(compare_starts(ps, None), StartComparison::Unknown);
        assert_eq!(compare_starts(None, None), StartComparison::Unknown);
    }
}
