use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use super::SetupDraftParams;
use crate::identity::ProcessIdentity;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceLoadResult {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub error: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub id: Option<String>,
    pub root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoadResult {
    pub identity: ProcessIdentity,
    pub loads: Vec<WorkspaceLoadResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartParams {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub setups: Option<BTreeMap<String, SetupDraftParams>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartResult {
    pub loads: Vec<WorkspaceLoadResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostParams {
    #[serde(deserialize_with = "Option::deserialize")]
    pub config: Option<String>,
    pub root: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub setup: Option<SetupDraftParams>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostResult {
    #[serde(deserialize_with = "Option::deserialize")]
    pub config: Option<String>,
    pub id: String,
    pub root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadNotificationParams {
    pub file: String,
    pub read_at: u64,
    pub root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandedParams {
    pub id: String,
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedParams {
    pub id: String,
    pub owner: ProcessIdentity,
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "QueuedTakeWire", into = "QueuedTakeWire")]
pub enum QueuedTakeResult {
    Taken,
    Declined { why: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetireParams {
    pub successor: ProcessIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineNotificationParams {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub id: Option<String>,
    pub line: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveRun {
    pub record: Value,
    pub work: Vec<LiveWork>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LiveWork {
    Agent(AgentWork),
    Command(CommandWork),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWork {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub agent: Option<String>,
    pub id: String,
    pub input: AgentInput,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub model: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub provider: Option<String>,
    pub session_id: String,
    pub step_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentInput {
    Steer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandWork {
    pub command: String,
    pub id: String,
    pub input: CommandInput,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub pid: Option<u32>,
    pub step_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandInput {
    Stdin,
    #[serde(rename = "none")]
    Disabled,
}

pub fn is_valid_live_runs(runs: &Value) -> bool {
    Vec::<LiveRun>::deserialize(runs).is_ok()
}

#[derive(Debug, Error)]
#[error("a declined take must say why")]
struct MissingWhy;

#[derive(Serialize, Deserialize)]
struct QueuedTakeWire {
    taken: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    why: Option<String>,
}

impl From<QueuedTakeResult> for QueuedTakeWire {
    fn from(result: QueuedTakeResult) -> Self {
        match result {
            QueuedTakeResult::Taken => Self {
                taken: true,
                why: None,
            },
            QueuedTakeResult::Declined { why } => Self {
                taken: false,
                why: Some(why),
            },
        }
    }
}

impl TryFrom<QueuedTakeWire> for QueuedTakeResult {
    type Error = MissingWhy;

    fn try_from(wire: QueuedTakeWire) -> Result<Self, Self::Error> {
        match wire {
            QueuedTakeWire { taken: true, .. } => Ok(Self::Taken),
            QueuedTakeWire { why: Some(why), .. } => Ok(Self::Declined { why }),
            QueuedTakeWire { why: None, .. } => Err(MissingWhy),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_json::{assert_roundtrip, from_json};
    use super::*;

    fn setup_draft() -> SetupDraftParams {
        SetupDraftParams {
            instructions: "do it".to_owned(),
            name: "demo".to_owned(),
            template: "basic".to_owned(),
        }
    }

    fn identity(started: Option<&str>) -> ProcessIdentity {
        ProcessIdentity {
            pid: 42,
            started: started.map(str::to_owned),
        }
    }

    #[test]
    fn process_identity_writes_null_when_start_is_unknown() {
        assert_roundtrip(&identity(None), r#"{"pid":42,"started":null}"#);
        assert_roundtrip(&identity(Some("Tue")), r#"{"pid":42,"started":"Tue"}"#);
    }

    #[test]
    fn process_identity_requires_the_started_key() {
        assert!(from_json::<ProcessIdentity>(r#"{"pid":42}"#).is_err());
    }

    #[test]
    fn load_result_nests_identity_and_loads() {
        let load = LoadResult {
            identity: identity(None),
            loads: vec![
                WorkspaceLoadResult {
                    error: None,
                    id: Some("w1".to_owned()),
                    root: "/a".to_owned(),
                },
                WorkspaceLoadResult {
                    error: Some("bad".to_owned()),
                    id: None,
                    root: "/b".to_owned(),
                },
            ],
        };

        assert_roundtrip(
            &load,
            r#"{"identity":{"pid":42,"started":null},"loads":[{"id":"w1","root":"/a"},{"error":"bad","root":"/b"}]}"#,
        );
    }

    #[test]
    fn start_params_omit_or_carry_setups() {
        let without = StartParams { setups: None };
        let with = StartParams {
            setups: Some(BTreeMap::from([("/repo".to_owned(), setup_draft())])),
        };

        assert_roundtrip(&without, "{}");
        assert_roundtrip(
            &with,
            r#"{"setups":{"/repo":{"instructions":"do it","name":"demo","template":"basic"}}}"#,
        );
    }

    #[test]
    fn start_result_lists_loads() {
        let start = StartResult {
            loads: vec![WorkspaceLoadResult {
                error: None,
                id: None,
                root: "/a".to_owned(),
            }],
        };

        assert_roundtrip(&start, r#"{"loads":[{"root":"/a"}]}"#);
    }

    #[test]
    fn host_params_write_null_config_and_omit_setup() {
        let host = HostParams {
            config: None,
            root: "/repo".to_owned(),
            setup: None,
        };

        assert_roundtrip(&host, r#"{"config":null,"root":"/repo"}"#);
        assert!(from_json::<HostParams>(r#"{"root":"/repo"}"#).is_err());
    }

    #[test]
    fn host_result_writes_null_config() {
        let host = HostResult {
            config: None,
            id: "w1".to_owned(),
            root: "/repo".to_owned(),
        };

        assert_roundtrip(&host, r#"{"config":null,"id":"w1","root":"/repo"}"#);
    }

    #[test]
    fn read_notification_params_use_read_at() {
        let read = ReadNotificationParams {
            file: "/repo/a.ts".to_owned(),
            read_at: 1_764_000_000_000,
            root: "/repo".to_owned(),
        };

        assert_roundtrip(
            &read,
            r#"{"file":"/repo/a.ts","readAt":1764000000000,"root":"/repo"}"#,
        );
    }

    #[test]
    fn handed_and_queued_params_use_run_id() {
        let handed = HandedParams {
            id: "w1".to_owned(),
            run_id: "r1".to_owned(),
        };
        let queued = QueuedParams {
            id: "w1".to_owned(),
            owner: identity(Some("Tue")),
            run_id: "r1".to_owned(),
        };

        assert_roundtrip(&handed, r#"{"id":"w1","runId":"r1"}"#);
        assert_roundtrip(
            &queued,
            r#"{"id":"w1","owner":{"pid":42,"started":"Tue"},"runId":"r1"}"#,
        );
    }

    #[test]
    fn queued_take_result_taken_is_a_bare_flag() {
        assert_roundtrip(&QueuedTakeResult::Taken, r#"{"taken":true}"#);
    }

    #[test]
    fn queued_take_result_declined_says_why() {
        let declined = QueuedTakeResult::Declined {
            why: "busy".to_owned(),
        };

        assert_roundtrip(&declined, r#"{"taken":false,"why":"busy"}"#);
    }

    #[test]
    fn queued_take_result_declined_without_why_is_rejected() {
        assert!(from_json::<QueuedTakeResult>(r#"{"taken":false}"#).is_err());
    }

    #[test]
    fn queued_take_result_taken_ignores_a_stray_why() {
        let parsed: QueuedTakeResult =
            from_json(r#"{"taken":true,"why":"x"}"#).expect("taken should parse");

        assert_eq!(parsed, QueuedTakeResult::Taken);
    }

    #[test]
    fn retire_params_name_the_successor() {
        let retire = RetireParams {
            successor: identity(None),
        };

        assert_roundtrip(&retire, r#"{"successor":{"pid":42,"started":null}}"#);
    }

    #[test]
    fn line_notification_params_omit_absent_id_and_root() {
        let bare = LineNotificationParams {
            id: None,
            line: "hi".to_owned(),
            root: None,
        };
        let full = LineNotificationParams {
            id: Some("w1".to_owned()),
            line: "hi".to_owned(),
            root: Some("/repo".to_owned()),
        };

        assert_roundtrip(&bare, r#"{"line":"hi"}"#);
        assert_roundtrip(&full, r#"{"id":"w1","line":"hi","root":"/repo"}"#);
    }

    #[test]
    fn agent_work_is_tagged_by_kind() {
        let work = LiveWork::Agent(AgentWork {
            agent: Some("coder".to_owned()),
            id: "u1".to_owned(),
            input: AgentInput::Steer,
            model: None,
            provider: None,
            session_id: "s1".to_owned(),
            step_id: "build".to_owned(),
        });

        assert_roundtrip(
            &work,
            r#"{"kind":"agent","agent":"coder","id":"u1","input":"steer","sessionId":"s1","stepId":"build"}"#,
        );
    }

    #[test]
    fn command_work_is_tagged_by_kind() {
        let work = LiveWork::Command(CommandWork {
            command: "bun test".to_owned(),
            id: "u2".to_owned(),
            input: CommandInput::Disabled,
            pid: Some(99),
            step_id: "check".to_owned(),
        });

        assert_roundtrip(
            &work,
            r#"{"kind":"command","command":"bun test","id":"u2","input":"none","pid":99,"stepId":"check"}"#,
        );
    }

    #[test]
    fn live_work_parses_regardless_of_key_order() {
        let parsed: LiveWork = from_json(
            r#"{"command":"ls","id":"u3","input":"stdin","kind":"command","stepId":"s"}"#,
        )
        .expect("command work should parse");

        assert!(matches!(
            parsed,
            LiveWork::Command(CommandWork {
                input: CommandInput::Stdin,
                pid: None,
                ..
            })
        ));
    }

    #[test]
    fn live_work_rejects_unknown_kinds_and_wrong_inputs() {
        assert!(from_json::<LiveWork>(r#"{"kind":"robot","id":"u"}"#).is_err());
        assert!(
            from_json::<LiveWork>(
                r#"{"kind":"agent","id":"u","input":"stdin","sessionId":"s","stepId":"t"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn live_run_keeps_the_record_opaque() {
        let run = LiveRun {
            record: json!({ "id": "r1", "status": "running" }),
            work: Vec::new(),
        };

        assert_roundtrip(
            &run,
            r#"{"record":{"id":"r1","status":"running"},"work":[]}"#,
        );
    }

    #[test]
    fn live_runs_are_checked_without_being_rebuilt() {
        let runs = json!([{
            "record": { "zeta": 1, "id": "r1" },
            "work": [{ "kind": "command", "command": "ls", "id": "u", "input": "stdin", "stepId": "s" }]
        }]);

        assert!(is_valid_live_runs(&runs));
        assert!(is_valid_live_runs(&json!([])));
        assert!(!is_valid_live_runs(
            &json!([{ "record": {}, "work": [{ "kind": "robot" }] }])
        ));
        assert!(!is_valid_live_runs(&json!({ "record": {} })));
        assert_eq!(
            runs.to_string(),
            r#"[{"record":{"zeta":1,"id":"r1"},"work":[{"kind":"command","command":"ls","id":"u","input":"stdin","stepId":"s"}]}]"#
        );
    }
}
