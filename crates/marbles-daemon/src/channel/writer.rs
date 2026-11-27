use std::future::Future;
use std::io;
use std::time::Duration;

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

use super::CloseReason;

const CLOSE_FLUSH_DEADLINE: Duration = Duration::from_millis(500);

#[derive(Debug)]
pub(super) enum Outbound {
    Frame(String),
    Close,
}

enum Burst {
    Written,
    Closing,
    Abandoned,
}

pub(super) async fn write_frames<W>(
    mut writer: W,
    mut queued: mpsc::UnboundedReceiver<Outbound>,
    finished: oneshot::Sender<CloseReason>,
    mut closed: watch::Receiver<bool>,
) where
    W: AsyncWrite + Unpin,
{
    let reason = loop {
        let burst = match queued.recv().await {
            Some(Outbound::Frame(frame)) => {
                write_burst(&mut writer, frame, &mut queued, &mut closed).await
            }
            Some(Outbound::Close) | None => Ok(Burst::Closing),
        };
        match burst {
            Ok(Burst::Written) => {}
            Ok(Burst::Closing) => {
                let _ = bounded(&mut closed, writer.shutdown()).await;
                break CloseReason::Local;
            }
            Ok(Burst::Abandoned) => break CloseReason::Local,
            Err(error) => break CloseReason::Io(error),
        }
    };
    let _ = finished.send(reason);
}

async fn write_burst<W>(
    writer: &mut W,
    first: String,
    queued: &mut mpsc::UnboundedReceiver<Outbound>,
    closed: &mut watch::Receiver<bool>,
) -> io::Result<Burst>
where
    W: AsyncWrite + Unpin,
{
    let Some(written) = bounded(closed, writer.write_all(first.as_bytes())).await else {
        return Ok(Burst::Abandoned);
    };
    written?;
    let mut burst = Burst::Written;
    while let Ok(next) = queued.try_recv() {
        match next {
            Outbound::Frame(frame) => {
                let Some(written) = bounded(closed, writer.write_all(frame.as_bytes())).await
                else {
                    return Ok(Burst::Abandoned);
                };
                written?;
            }
            Outbound::Close => {
                burst = Burst::Closing;
                break;
            }
        }
    }
    let Some(flushed) = bounded(closed, writer.flush()).await else {
        return Ok(Burst::Abandoned);
    };
    flushed?;
    Ok(burst)
}

async fn bounded<T>(
    closed: &mut watch::Receiver<bool>,
    write: impl Future<Output = io::Result<T>>,
) -> Option<io::Result<T>> {
    tokio::select! {
        done = write => Some(done),
        () = flush_deadline(closed) => None,
    }
}

async fn flush_deadline(closed: &mut watch::Receiver<bool>) {
    if closed.wait_for(|closed| *closed).await.is_err() {
        std::future::pending::<()>().await;
    }
    tokio::time::sleep(CLOSE_FLUSH_DEADLINE).await;
}
