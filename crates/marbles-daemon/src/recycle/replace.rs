use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::Command;

use super::{BinaryDigest, RecycleTarget};

pub const RECYCLED_FROM: &str = "--recycled-from";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecyclePlan {
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub previous_digest: BinaryDigest,
    pub new_digest: BinaryDigest,
}

impl RecyclePlan {
    pub fn from_target(
        target: RecycleTarget,
        current_args: impl IntoIterator<Item = OsString>,
    ) -> Self {
        let mut args = Vec::new();
        let mut current = current_args.into_iter();
        while let Some(arg) = current.next() {
            if arg == RECYCLED_FROM {
                current.next();
            } else {
                args.push(arg);
            }
        }
        args.push(RECYCLED_FROM.into());
        args.push(target.previous_digest.to_string().into());
        Self {
            executable: target.executable,
            args,
            previous_digest: target.previous_digest,
            new_digest: target.new_digest,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(&self.args);
        command
    }
}

#[cfg(unix)]
pub fn replace_current_process(plan: &RecyclePlan) -> io::Error {
    use std::os::unix::process::CommandExt;

    plan.command().exec()
}

#[cfg(not(unix))]
pub fn spawn_successor(plan: &RecyclePlan) -> io::Result<()> {
    plan.command().spawn().map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const PREVIOUS: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const NEW: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    fn digest(hex: &str) -> BinaryDigest {
        hex.parse().expect("a digest")
    }

    fn target() -> RecycleTarget {
        RecycleTarget {
            executable: PathBuf::from("/opt/marbles/bin/marbles-daemon"),
            previous_digest: digest(PREVIOUS),
            new_digest: digest(NEW),
        }
    }

    fn args(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn the_plan_runs_the_target_and_names_the_previous_digest() {
        let plan =
            RecyclePlan::from_target(target(), args(&["--home", "/h", "--version", "1.2.3"]));

        assert_eq!(
            plan,
            RecyclePlan {
                executable: PathBuf::from("/opt/marbles/bin/marbles-daemon"),
                args: args(&[
                    "--home",
                    "/h",
                    "--version",
                    "1.2.3",
                    RECYCLED_FROM,
                    PREVIOUS
                ]),
                previous_digest: digest(PREVIOUS),
                new_digest: digest(NEW),
            }
        );
    }

    #[test]
    fn an_earlier_recycled_from_is_replaced_rather_than_accumulated() {
        let plan = RecyclePlan::from_target(
            target(),
            args(&["--home", "/h", RECYCLED_FROM, OLD, "--no-self-recycle"]),
        );

        assert_eq!(
            plan.args,
            args(&["--home", "/h", "--no-self-recycle", RECYCLED_FROM, PREVIOUS])
        );
    }

    #[test]
    fn a_dangling_recycled_from_is_dropped() {
        let plan = RecyclePlan::from_target(target(), args(&["--home", "/h", RECYCLED_FROM]));

        assert_eq!(plan.args, args(&["--home", "/h", RECYCLED_FROM, PREVIOUS]));
    }
}
