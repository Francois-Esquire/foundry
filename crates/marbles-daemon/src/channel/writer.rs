use std::io;

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use super::CloseReason;

#[derive(Debug)]
pub(super) enum Outbound {
    Frame(String),
    Close,
}

enum Burst {
    Written,
    Closing,
}

pub(super) async fn write_frames<W>(
    mut writer: W,
    mut queued: mpsc::UnboundedReceiver<Outbound>,
    finished: oneshot::Sender<CloseReason>,
) where
    W: AsyncWrite + Unpin,
{
    let reason = loop {
        let burst = match queued.recv().await {
            Some(Outbound::Frame(frame)) => write_burst(&mut writer, frame, &mut queued).await,
            Some(Outbound::Close) | None => Ok(Burst::Closing),
        };
        match burst {
            Ok(Burst::Written) => {}
            Ok(Burst::Closing) => {
                let _ = writer.shutdown().await;
                break CloseReason::Local;
            }
            Err(error) => break CloseReason::Io(error),
        }
    };
    let _ = finished.send(reason);
}

async fn write_burst<W>(
    writer: &mut W,
    first: String,
    queued: &mut mpsc::UnboundedReceiver<Outbound>,
) -> io::Result<Burst>
where
    W: AsyncWrite + Unpin,
{
    writer.write_all(first.as_bytes()).await?;
    let mut burst = Burst::Written;
    while let Ok(next) = queued.try_recv() {
        match next {
            Outbound::Frame(frame) => writer.write_all(frame.as_bytes()).await?,
            Outbound::Close => {
                burst = Burst::Closing;
                break;
            }
        }
    }
    writer.flush().await?;
    Ok(burst)
}
