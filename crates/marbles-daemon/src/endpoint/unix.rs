use std::fs::{self, Permissions};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use thiserror::Error;
use tokio::net::UnixListener;
use tokio::sync::mpsc;

use crate::channel::{self, ChannelEvent, ChannelHandle};

pub const SOCKET_MODE: u32 = 0o600;

#[derive(Debug, Error)]
#[error("could not {action} {}: {source}", .path.display())]
pub struct EndpointError {
    action: &'static str,
    path: PathBuf,
    source: io::Error,
}

#[derive(Debug)]
pub struct Endpoint {
    listener: UnixListener,
    socket: PathBuf,
}

impl Endpoint {
    pub fn bind(socket: &Path) -> Result<Self, EndpointError> {
        remove_if_present(socket).map_err(failed("remove the stale socket", socket))?;
        let listener = UnixListener::bind(socket).map_err(failed("listen on", socket))?;
        let endpoint = Self {
            listener,
            socket: socket.to_owned(),
        };
        match fs::set_permissions(socket, Permissions::from_mode(SOCKET_MODE)) {
            Ok(()) => Ok(endpoint),
            Err(source) => {
                endpoint.close();
                Err(failed("secure", socket)(source))
            }
        }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    pub async fn accept(&self) -> io::Result<(ChannelHandle, mpsc::Receiver<ChannelEvent>)> {
        let (stream, _) = self.listener.accept().await?;
        Ok(channel::open(stream))
    }

    pub fn close(self) {
        let socket = self.abandon();
        let _ = remove_if_present(&socket);
    }

    pub fn abandon(self) -> PathBuf {
        let Self { listener, socket } = self;
        drop(listener);
        socket
    }
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn failed(action: &'static str, path: &Path) -> impl FnOnce(io::Error) -> EndpointError {
    let path = path.to_owned();
    move |source| EndpointError {
        action,
        path,
        source,
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::FileTypeExt;

    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;

    use super::*;
    use crate::protocol::{Response, WireMessage, decode};

    fn short_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("md")
            .tempdir_in("/tmp")
            .expect("a temporary directory")
    }

    #[tokio::test]
    async fn binding_replaces_a_stale_socket_and_secures_it() {
        let dir = short_dir();
        let socket = dir.path().join("s.sock");
        fs::write(&socket, "stale").expect("a stale file");

        let endpoint = Endpoint::bind(&socket).expect("the endpoint");

        let metadata = fs::metadata(&socket).expect("the socket");
        assert!(metadata.file_type().is_socket());
        assert_eq!(metadata.permissions().mode() & 0o777, SOCKET_MODE);
        assert_eq!(endpoint.socket(), socket);
    }

    #[tokio::test]
    async fn accepted_connections_speak_through_a_channel() {
        let dir = short_dir();
        let socket = dir.path().join("s.sock");
        let endpoint = Endpoint::bind(&socket).expect("the endpoint");
        let mut client = UnixStream::connect(&socket).await.expect("a client");

        let (channel, mut events) = endpoint.accept().await.expect("an accepted client");
        client
            .write_all(b"{\"id\":1,\"method\":\"hello\"}\n")
            .await
            .expect("the request");
        let Some(ChannelEvent::Request(request)) = events.recv().await else {
            panic!("the request should arrive");
        };
        channel
            .respond(Response::ok(request.id, json!("hi")))
            .expect("the reply");
        let mut lines = BufReader::new(client).lines();
        let line = lines.next_line().await.expect("a line").expect("a reply");

        assert_eq!(
            decode(&line).ok(),
            Some(WireMessage::Response(Response::ok(1, json!("hi"))))
        );
    }

    #[tokio::test]
    async fn closing_removes_the_socket() {
        let dir = short_dir();
        let socket = dir.path().join("s.sock");

        Endpoint::bind(&socket).expect("the endpoint").close();

        assert!(!socket.exists());
    }

    #[tokio::test]
    async fn abandoning_leaves_the_path_for_a_successor() {
        let dir = short_dir();
        let socket = dir.path().join("s.sock");
        let endpoint = Endpoint::bind(&socket).expect("the endpoint");
        fs::remove_file(&socket).expect("the successor removes the socket");
        fs::write(&socket, "successor").expect("the successor's socket");

        assert_eq!(endpoint.abandon(), socket);
        assert_eq!(
            fs::read_to_string(&socket).ok().as_deref(),
            Some("successor")
        );
    }
}
