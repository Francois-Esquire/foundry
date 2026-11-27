mod pending;
mod reader;
#[cfg(test)]
mod tests;
mod writer;

use std::future::Future;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};

use self::pending::Pending;
use self::writer::Outbound;
use crate::protocol::{
    LineTooLong, NonEmptyString, Notification, Request, Response, WireError, WireMessage, encode,
};

const EVENT_CAPACITY: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ChannelError {
    #[error("the connection closed")]
    Closed,
    #[error("{}", .0.message)]
    Remote(WireError),
}

#[derive(Debug, Error)]
pub enum CloseReason {
    #[error("the peer closed the connection")]
    Eof,
    #[error("the connection was closed locally")]
    Local,
    #[error(transparent)]
    LineTooLong(LineTooLong),
    #[error("the connection failed: {0}")]
    Io(io::Error),
}

impl CloseReason {
    pub fn is_failure(&self) -> bool {
        matches!(self, Self::LineTooLong(_) | Self::Io(_))
    }
}

#[derive(Debug)]
pub enum ChannelEvent {
    Request(Request),
    Notification(Notification),
    Closed(CloseReason),
}

#[derive(Debug, Clone)]
pub struct ChannelHandle {
    pending: Arc<Pending>,
    outbound: mpsc::UnboundedSender<Outbound>,
    closing: Arc<watch::Sender<bool>>,
    seen_notifications: Arc<AtomicU64>,
}

pub fn open<T>(transport: T) -> (ChannelHandle, mpsc::Receiver<ChannelEvent>)
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (read_half, write_half) = tokio::io::split(transport);
    let (outbound, queued) = mpsc::unbounded_channel();
    let (events, received) = mpsc::channel(EVENT_CAPACITY);
    let (written, writer_done) = oneshot::channel();
    let (closing, closed) = watch::channel(false);
    let handle = ChannelHandle {
        pending: Arc::new(Pending::default()),
        outbound,
        closing: Arc::new(closing),
        seen_notifications: Arc::new(AtomicU64::new(0)),
    };
    tokio::spawn(writer::write_frames(write_half, queued, written, closed));
    tokio::spawn(reader::read_frames(
        read_half,
        handle.clone(),
        events,
        writer_done,
    ));
    (handle, received)
}

impl ChannelHandle {
    pub fn request(
        &self,
        method: impl Into<NonEmptyString>,
        params: Option<Value>,
    ) -> impl Future<Output = Result<Option<Value>, ChannelError>> + Send + 'static {
        let method = method.into();
        let registered = self.pending.register(|id| {
            let request = Request { id, method, params };
            self.queue(request.into())
        });
        async move {
            match registered {
                Some(answer) => answer.await.unwrap_or(Err(ChannelError::Closed)),
                None => Err(ChannelError::Closed),
            }
        }
    }

    pub fn notify(
        &self,
        method: impl Into<NonEmptyString>,
        params: Option<Value>,
    ) -> Result<(), ChannelError> {
        self.send(
            Notification {
                method: method.into(),
                params,
            }
            .into(),
        )
    }

    pub fn respond(&self, response: Response) -> Result<(), ChannelError> {
        self.send(response.into())
    }

    pub fn close(&self) {
        if self.pending.close() {
            let _ = self.outbound.send(Outbound::Close);
        }
        self.closing.send_replace(true);
    }

    pub fn seen_notifications(&self) -> u64 {
        self.seen_notifications.load(Ordering::Acquire)
    }

    fn note_notification(&self) {
        self.seen_notifications.fetch_add(1, Ordering::Release);
    }

    pub fn is_closed(&self) -> bool {
        self.pending.is_closed()
    }

    fn send(&self, message: WireMessage) -> Result<(), ChannelError> {
        if self.pending.is_closed() || !self.queue(message) {
            return Err(ChannelError::Closed);
        }
        Ok(())
    }

    fn queue(&self, message: WireMessage) -> bool {
        self.outbound
            .send(Outbound::Frame(encode(&message)))
            .is_ok()
    }

    fn settle(&self, response: Response) {
        let outcome = match response.error {
            Some(error) => Err(ChannelError::Remote(error)),
            None => Ok(response.result),
        };
        self.pending.settle(response.id, outcome);
    }
}
