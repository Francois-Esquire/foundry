use std::io::{self, Write};

pub trait OutputSink: Send + Sync + 'static {
    fn line(&self, line: &str);
}

#[derive(Debug, Clone, Copy, Default)]
pub struct StdoutSink;

impl OutputSink for StdoutSink {
    fn line(&self, line: &str) {
        let _ = writeln!(io::stdout().lock(), "{line}");
    }
}
