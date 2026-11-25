use std::fs;
use std::os::unix::fs::MetadataExt;

const NANOS_PER_MILLI: f64 = 1_000_000.0;
const MILLIS_PER_SECOND: f64 = 1_000.0;

pub(super) fn ctime_ms(metadata: &fs::Metadata) -> f64 {
    metadata.ctime() as f64 * MILLIS_PER_SECOND + metadata.ctime_nsec() as f64 / NANOS_PER_MILLI
}
