use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use super::files::write_atomic;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessHost {
    Daemon,
    #[serde(rename = "worker")]
    Standalone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedProcess {
    pub artifacts: Option<PathBuf>,
    pub config: Option<PathBuf>,
    pub host: ProcessHost,
    pub pid: u32,
    pub socket: Option<PathBuf>,
    pub started_at: String,
    pub marbles_version: Option<String>,
}

#[derive(Serialize)]
struct Descriptor<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    artifacts: Option<&'a Path>,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<&'a Path>,
    host: ProcessHost,
    #[serde(skip_serializing_if = "Option::is_none")]
    socket: Option<&'a Path>,
    version: u32,
    pid: u32,
    #[serde(rename = "startedAt")]
    started_at: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    marbles: Option<&'a str>,
}

impl fmt::Display for ProcessHost {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Daemon => "daemon",
            Self::Standalone => "worker",
        })
    }
}

impl ProcessHost {
    fn parse(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "daemon" => Some(Self::Daemon),
            "worker" => Some(Self::Standalone),
            _ => None,
        }
    }
}

impl RecordedProcess {
    pub(super) fn write(&self, path: &Path) -> io::Result<()> {
        let descriptor = Descriptor {
            artifacts: self.artifacts.as_deref(),
            config: self.config.as_deref(),
            host: self.host,
            socket: self.socket.as_deref(),
            version: SCHEMA_VERSION,
            pid: self.pid,
            started_at: &self.started_at,
            marbles: self.marbles_version.as_deref(),
        };
        let encoded = serde_json::to_vec_pretty(&descriptor).map_err(io::Error::other)?;
        write_atomic(path, &encoded, None)
    }

    pub(super) fn read(path: &Path) -> Option<Self> {
        let contents = fs::read(path).ok()?;
        let Value::Object(fields) = serde_json::from_slice(&contents).ok()? else {
            return None;
        };
        Some(Self {
            artifacts: path_field(&fields, "artifacts"),
            config: path_field(&fields, "config"),
            host: ProcessHost::parse(fields.get("host")?)?,
            pid: fields.get("pid")?.as_u64()?.try_into().ok()?,
            socket: path_field(&fields, "socket"),
            started_at: fields.get("startedAt")?.as_str()?.to_owned(),
            marbles_version: string_field(&fields, "marbles"),
        })
    }
}

fn string_field(fields: &Map<String, Value>, key: &str) -> Option<String> {
    fields.get(key)?.as_str().map(str::to_owned)
}

fn path_field(fields: &Map<String, Value>, key: &str) -> Option<PathBuf> {
    string_field(fields, key).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn daemon_record() -> RecordedProcess {
        RecordedProcess {
            artifacts: Some(PathBuf::from("/h/artifacts")),
            config: None,
            host: ProcessHost::Daemon,
            pid: 42,
            socket: Some(PathBuf::from("/h/marbles/marbles.sock")),
            started_at: "2026-11-25T14:46:24.123Z".to_owned(),
            marbles_version: Some("0.0.4".to_owned()),
        }
    }

    #[test]
    fn the_descriptor_matches_the_typescript_daemon_byte_for_byte() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("process.json");
        daemon_record().write(&path).expect("the descriptor");

        assert_eq!(
            fs::read_to_string(&path).expect("the descriptor"),
            r#"{
  "artifacts": "/h/artifacts",
  "host": "daemon",
  "socket": "/h/marbles/marbles.sock",
  "version": 1,
  "pid": 42,
  "startedAt": "2026-11-25T14:46:24.123Z",
  "marbles": "0.0.4"
}"#
        );
        assert_eq!(RecordedProcess::read(&path), Some(daemon_record()));
    }

    #[test]
    fn a_standalone_descriptor_records_its_config() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("process.json");
        let standalone = RecordedProcess {
            config: Some(PathBuf::from("/w/marbles.config.ts")),
            host: ProcessHost::Standalone,
            socket: None,
            ..daemon_record()
        };
        standalone.write(&path).expect("the descriptor");

        assert!(
            fs::read_to_string(&path)
                .expect("the descriptor")
                .contains(r#""host": "worker""#)
        );
        assert_eq!(ProcessHost::Standalone.to_string(), "worker");
        assert_eq!(RecordedProcess::read(&path), Some(standalone));
    }

    #[test]
    fn unreadable_descriptors_are_ignored() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("process.json");

        assert_eq!(RecordedProcess::read(&path), None);
        for broken in [
            "not json",
            "[]",
            r#"{"host":"daemon","startedAt":"x"}"#,
            r#"{"pid":1,"host":"engine","startedAt":"x"}"#,
            r#"{"pid":1,"host":"daemon"}"#,
        ] {
            fs::write(&path, broken).expect("the broken descriptor");
            assert_eq!(RecordedProcess::read(&path), None, "{broken}");
        }
    }

    #[test]
    fn mistyped_optional_fields_read_as_absent() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("process.json");
        fs::write(
            &path,
            r#"{"pid":7,"host":"worker","startedAt":"t","config":null,"socket":3,"marbles":false}"#,
        )
        .expect("the descriptor");

        assert_eq!(
            RecordedProcess::read(&path),
            Some(RecordedProcess {
                artifacts: None,
                config: None,
                host: ProcessHost::Standalone,
                pid: 7,
                socket: None,
                started_at: "t".to_owned(),
                marbles_version: None,
            })
        );
    }
}
