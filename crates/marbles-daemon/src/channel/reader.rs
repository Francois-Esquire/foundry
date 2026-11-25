use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{mpsc, oneshot};

use super::{ChannelEvent, ChannelHandle, CloseReason};
use crate::protocol::{
    LineSplitter, LineTooLong, OverflowPolicy, PushedLines, WireMessage, decode,
};

const READ_CHUNK_BYTES: usize = 64 * 1024;

pub(super) async fn read_frames<R>(
    mut reader: R,
    handle: ChannelHandle,
    events: mpsc::Sender<ChannelEvent>,
    mut writer_done: oneshot::Receiver<CloseReason>,
) where
    R: AsyncRead + Unpin,
{
    let mut splitter = LineSplitter::new(OverflowPolicy::Fail);
    let mut buffer = vec![0; READ_CHUNK_BYTES];
    let reason = loop {
        tokio::select! {
            finished = &mut writer_done => break finished.unwrap_or(CloseReason::Local),
            read = reader.read(&mut buffer) => match read {
                Ok(0) => break CloseReason::Eof,
                Ok(count) => {
                    let pushed = splitter.push(&buffer[..count]);
                    if let Some(overflow) = deliver(&handle, &events, pushed).await {
                        break CloseReason::LineTooLong(overflow);
                    }
                }
                Err(error) => break CloseReason::Io(error),
            },
        }
    };
    handle.close();
    let _ = events.send(ChannelEvent::Closed(reason)).await;
}

async fn deliver(
    handle: &ChannelHandle,
    events: &mpsc::Sender<ChannelEvent>,
    pushed: PushedLines,
) -> Option<LineTooLong> {
    for line in pushed.lines.into_iter().flatten() {
        let event = match decode(&line) {
            Ok(WireMessage::Response(response)) => {
                handle.settle(response);
                continue;
            }
            Ok(WireMessage::Request(request)) => ChannelEvent::Request(request),
            Ok(WireMessage::Notification(notification)) => ChannelEvent::Notification(notification),
            Err(_) => continue,
        };
        let _ = events.send(event).await;
    }
    pushed.overflow
}
