mod digest;
mod replace;
mod watch;

pub use self::digest::{BinaryDigest, InvalidDigest};
#[cfg(unix)]
pub use self::replace::replace_current_process;
#[cfg(not(unix))]
pub use self::replace::spawn_successor;
pub use self::replace::{RECYCLED_FROM, RecyclePlan};
pub use self::watch::{BinaryChange, BinaryWatch, RecycleTarget, STABILITY_WINDOW};
