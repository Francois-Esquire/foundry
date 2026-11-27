use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::Value;
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::Layout;
use crate::channel::{self, ChannelError, ChannelEvent, ChannelHandle, CloseReason};
use crate::lifecycle::OutputSink;
use crate::protocol::{NonEmptyString, Notification};

pub(crate) const PATIENCE: Duration = Duration::from_secs(10);

#[derive(Clone, Default)]
pub(crate) struct Printed(Arc<Mutex<Vec<String>>>);

impl Printed {
    pub(crate) fn lines(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn has(&self, expected: &str) -> bool {
        self.lines().iter().any(|line| line == expected)
    }

    pub(crate) fn has_containing(&self, expected: &str) -> bool {
        self.lines().iter().any(|line| line.contains(expected))
    }
}

impl OutputSink for Printed {
    fn line(&self, line: &str) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(line.to_owned());
    }
}

pub(crate) struct Home {
    _dir: tempfile::TempDir,
    pub(crate) layout: Layout,
}

pub(crate) fn home() -> Home {
    let dir = tempfile::Builder::new()
        .prefix("md")
        .tempdir_in("/tmp")
        .expect("a temporary home");
    let layout = Layout::from_home(dir.path());
    Home { _dir: dir, layout }
}

pub(crate) async fn within<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(PATIENCE, work)
        .await
        .expect("the work should finish in time")
}

pub(crate) async fn eventually(mut check: impl FnMut() -> bool) {
    within(async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
}

pub(crate) struct Client {
    pub(crate) channel: ChannelHandle,
    pub(crate) events: mpsc::Receiver<ChannelEvent>,
}

impl Client {
    pub(crate) async fn connect(socket: &Path) -> Self {
        let stream = within(UnixStream::connect(socket))
            .await
            .expect("the daemon should accept");
        let (channel, events) = channel::open(stream);
        Self { channel, events }
    }

    pub(crate) async fn ask(
        &self,
        method: impl Into<NonEmptyString>,
        params: Option<Value>,
    ) -> Result<Option<Value>, ChannelError> {
        within(self.channel.request(method, params)).await
    }

    pub(crate) async fn notification(&mut self) -> Notification {
        match within(self.events.recv()).await {
            Some(ChannelEvent::Notification(notification)) => notification,
            other => panic!("expected a notification, got {other:?}"),
        }
    }

    pub(crate) async fn closed(&mut self) -> CloseReason {
        match within(self.events.recv()).await {
            Some(ChannelEvent::Closed(reason)) => reason,
            other => panic!("expected the connection to close, got {other:?}"),
        }
    }
}
