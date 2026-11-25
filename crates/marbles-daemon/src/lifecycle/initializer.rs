use std::error::Error;
use std::future::Future;
use std::pin::Pin;

use thiserror::Error;

pub type Initialization<'a> = Pin<Box<dyn Future<Output = Result<(), InitError>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitializeTrigger {
    Start,
    ProcessChange,
}

#[derive(Debug, Error)]
#[error("{0}")]
pub struct InitError(Box<dyn Error + Send + Sync>);

impl InitError {
    pub fn new(error: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        Self(error.into())
    }
}

pub trait Initializer: Send + Sync + 'static {
    fn initialize(&self, trigger: InitializeTrigger) -> Initialization<'_>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoopInitializer;

impl Initializer for NoopInitializer {
    fn initialize(&self, _trigger: InitializeTrigger) -> Initialization<'_> {
        Box::pin(async { Ok(()) })
    }
}
