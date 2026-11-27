use std::future::Future;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{
    AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, ReadHalf, WriteHalf,
};

use super::*;
use crate::protocol::{ClientNotification, DaemonMethod, MAX_LINE_BYTES};

const PATIENCE: Duration = Duration::from_secs(5);
const DUPLEX_BYTES: usize = 64 * 1024;

struct Peer {
    lines: Lines<BufReader<ReadHalf<DuplexStream>>>,
    writer: WriteHalf<DuplexStream>,
}

impl Peer {
    async fn line(&mut self) -> Option<Value> {
        let line = within(self.lines.next_line())
            .await
            .expect("the peer should read");
        line.map(|line| serde_json::from_str(&line).expect("the channel should write JSON"))
    }

    async fn send(&mut self, text: &str) {
        within(self.writer.write_all(text.as_bytes()))
            .await
            .expect("the peer should write");
    }
}

struct Opened {
    handle: ChannelHandle,
    events: mpsc::Receiver<ChannelEvent>,
    peer: Peer,
}

async fn next(events: &mut mpsc::Receiver<ChannelEvent>) -> ChannelEvent {
    within(events.recv())
        .await
        .expect("the channel should emit an event")
}

fn opened() -> Opened {
    let (ours, theirs) = tokio::io::duplex(DUPLEX_BYTES);
    let (handle, events) = open(ours);
    let (reader, writer) = tokio::io::split(theirs);
    Opened {
        handle,
        events,
        peer: Peer {
            lines: BufReader::new(reader).lines(),
            writer,
        },
    }
}

async fn within<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(PATIENCE, work)
        .await
        .expect("the work should finish in time")
}

#[tokio::test]
async fn a_request_resolves_with_its_response() {
    let mut opened = opened();
    let answer = opened.handle.request(DaemonMethod::Hello, None);

    assert_eq!(
        opened.peer.line().await,
        Some(json!({ "id": 0, "method": "hello" }))
    );
    opened
        .peer
        .send("{\"id\":0,\"result\":{\"ok\":true}}\n")
        .await;

    assert_eq!(within(answer).await, Ok(Some(json!({ "ok": true }))));
}

#[tokio::test]
async fn a_response_without_a_result_resolves_empty() {
    let mut opened = opened();
    let answer = opened
        .handle
        .request(DaemonMethod::Subscribe, Some(json!({ "id": "w1" })));

    assert_eq!(
        opened.peer.line().await,
        Some(json!({ "id": 0, "method": "subscribe", "params": { "id": "w1" } }))
    );
    opened.peer.send("{\"id\":0}\n").await;

    assert_eq!(within(answer).await, Ok(None));
}

#[tokio::test]
async fn concurrent_requests_match_out_of_order_responses() {
    let mut opened = opened();
    let first = opened.handle.request(DaemonMethod::Hello, None);
    let second = opened.handle.request(DaemonMethod::Workspaces, None);
    opened.peer.line().await;
    opened.peer.line().await;

    opened
        .peer
        .send("{\"id\":1,\"result\":\"second\"}\n{\"id\":0,\"result\":\"first\"}\n")
        .await;

    assert_eq!(within(second).await, Ok(Some(json!("second"))));
    assert_eq!(within(first).await, Ok(Some(json!("first"))));
}

#[tokio::test]
async fn a_remote_error_fails_its_request() {
    let mut opened = opened();
    let answer = opened.handle.request(DaemonMethod::Hello, None);
    opened.peer.line().await;

    opened
        .peer
        .send("{\"error\":{\"message\":\"boom\",\"name\":\"TypeError\"},\"id\":0}\n")
        .await;

    assert_eq!(
        within(answer).await,
        Err(ChannelError::Remote(WireError::named("TypeError", "boom")))
    );
}

#[tokio::test]
async fn inbound_requests_and_notifications_become_events() {
    let mut opened = opened();

    opened
        .peer
        .send(
            "{\"id\":4,\"method\":\"hello\"}\n{\"method\":\"line\",\"params\":{\"line\":\"hi\"}}\n",
        )
        .await;

    let ChannelEvent::Request(request) = next(&mut opened.events).await else {
        panic!("a request should arrive first");
    };
    assert_eq!(request, Request::new(4, DaemonMethod::Hello));
    let ChannelEvent::Notification(notification) = next(&mut opened.events).await else {
        panic!("a notification should follow");
    };
    assert_eq!(
        notification,
        Notification::new(ClientNotification::Line).with_params(json!({ "line": "hi" }))
    );
}

#[tokio::test]
async fn replies_and_notifications_reach_the_peer() {
    let mut opened = opened();

    opened
        .handle
        .respond(Response::ok(4, json!([])))
        .expect("the reply should queue");
    opened
        .handle
        .notify(ClientNotification::Line, Some(json!({ "line": "hi" })))
        .expect("the notification should queue");

    assert_eq!(
        opened.peer.line().await,
        Some(json!({ "id": 4, "result": [] }))
    );
    assert_eq!(
        opened.peer.line().await,
        Some(json!({ "method": "line", "params": { "line": "hi" } }))
    );
}

#[tokio::test]
async fn malformed_lines_are_ignored() {
    let mut opened = opened();
    let answer = opened.handle.request(DaemonMethod::Hello, None);
    opened.peer.line().await;

    opened
        .peer
        .send("not json\n[1]\n\u{0}\n{\"result\":1}\n{\"id\":99,\"result\":1}\n{\"id\":0,\"result\":2}\n")
        .await;

    assert_eq!(within(answer).await, Ok(Some(json!(2))));
    assert!(!opened.handle.is_closed());
}

#[tokio::test]
async fn an_oversized_line_closes_the_channel_and_fails_pending_requests() {
    let mut opened = opened();
    let answer = opened.handle.request(DaemonMethod::Hello, None);
    opened.peer.line().await;
    let mut writer = opened.peer.writer;
    tokio::spawn(async move {
        let _ = writer.write_all(&vec![b'a'; MAX_LINE_BYTES + 1]).await;
    });

    assert_eq!(within(answer).await, Err(ChannelError::Closed));
    assert!(matches!(
        next(&mut opened.events).await,
        ChannelEvent::Closed(CloseReason::LineTooLong(LineTooLong {
            limit: MAX_LINE_BYTES
        }))
    ));
    assert!(opened.handle.is_closed());
    assert_eq!(opened.peer.lines.next_line().await.ok(), Some(None));
}

#[tokio::test]
async fn peer_eof_fails_pending_requests() {
    let mut opened = opened();
    let answer = opened.handle.request(DaemonMethod::Hello, None);
    opened.peer.line().await;

    drop(opened.peer);

    assert_eq!(within(answer).await, Err(ChannelError::Closed));
    assert!(matches!(
        next(&mut opened.events).await,
        ChannelEvent::Closed(CloseReason::Eof)
    ));
    assert!(opened.handle.is_closed());
}

#[tokio::test]
async fn closing_flushes_queued_replies_before_eof() {
    let mut opened = opened();
    let pending = opened.handle.request(DaemonMethod::Hello, None);

    opened
        .handle
        .respond(Response::empty(7))
        .expect("the reply should queue");
    opened.handle.close();

    assert!(opened.handle.is_closed());
    assert_eq!(within(pending).await, Err(ChannelError::Closed));
    assert_eq!(
        opened.peer.line().await,
        Some(json!({ "id": 0, "method": "hello" }))
    );
    assert_eq!(opened.peer.line().await, Some(json!({ "id": 7 })));
    assert_eq!(opened.peer.line().await, None);
    assert!(matches!(
        next(&mut opened.events).await,
        ChannelEvent::Closed(CloseReason::Local)
    ));
}

#[tokio::test]
async fn a_closed_channel_refuses_new_traffic() {
    let opened = opened();
    opened.handle.close();

    assert_eq!(
        within(opened.handle.request(DaemonMethod::Hello, None)).await,
        Err(ChannelError::Closed)
    );
    assert_eq!(
        opened.handle.notify(ClientNotification::Line, None),
        Err(ChannelError::Closed)
    );
    assert_eq!(
        opened.handle.respond(Response::empty(1)),
        Err(ChannelError::Closed)
    );
}

#[tokio::test]
async fn closing_twice_emits_one_closed_event() {
    let mut opened = opened();

    opened.handle.close();
    opened.handle.close();

    assert!(matches!(
        next(&mut opened.events).await,
        ChannelEvent::Closed(CloseReason::Local)
    ));
    assert!(within(opened.events.recv()).await.is_none());
}

#[tokio::test]
async fn closing_interrupts_a_write_to_a_peer_that_never_reads() {
    let (ours, _theirs) = tokio::io::duplex(64);
    let (handle, mut events) = open(ours);
    let oversized = "x".repeat(16 * 1024);

    handle
        .notify(ClientNotification::Line, Some(json!({ "line": oversized })))
        .expect("the notification should queue");
    tokio::time::sleep(Duration::from_millis(50)).await;
    handle.close();

    let closed = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .expect("closing should not wait on a stalled peer");
    assert!(matches!(
        closed,
        Some(ChannelEvent::Closed(CloseReason::Local))
    ));
}

#[tokio::test]
async fn a_response_settles_after_the_notifications_that_preceded_it() {
    let mut opened = opened();
    let pending = opened.handle.request(DaemonMethod::Hello, None);
    assert_eq!(opened.handle.seen_notifications(), 0);

    opened
        .peer
        .send("{\"method\":\"line\"}\n{\"method\":\"line\"}\n{\"id\":0}\n")
        .await;

    assert_eq!(within(pending).await, Ok(None));
    assert!(opened.handle.seen_notifications() >= 2);
}
