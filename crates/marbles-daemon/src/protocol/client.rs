use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{DaemonMethod, NonEmptyString, ProtocolError, Request, WorkspaceMethod};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub artifacts: String,
    pub pid: u32,
    pub protocol: u32,
    pub started_at: String,
    pub state: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupDraftParams {
    pub instructions: String,
    pub name: String,
    pub template: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachParams {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub root: Option<NonEmptyString>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub setup: Option<SetupDraftParams>,
    pub source: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceIdParams {
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisterParams {
    pub token: NonEmptyString,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceState {
    Starting,
    Ready,
    Reloading,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    #[serde(deserialize_with = "Option::deserialize")]
    pub config: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub error: Option<String>,
    pub id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::field::absent_or_value"
    )]
    pub pid: Option<u32>,
    pub root: String,
    pub state: WorkspaceState,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DaemonRequest {
    Hello,
    Workspaces,
    Attach(AttachParams),
    Detach(WorkspaceIdParams),
    Reload(WorkspaceIdParams),
    Subscribe(WorkspaceIdParams),
    Unsubscribe(WorkspaceIdParams),
    Shutdown,
    Register(RegisterParams),
    Workspace {
        method: WorkspaceMethod,
        id: NonEmptyString,
        params: Map<String, Value>,
    },
}

#[derive(Deserialize)]
struct WorkspaceCall {
    id: NonEmptyString,
    #[serde(flatten)]
    params: Map<String, Value>,
}

impl DaemonRequest {
    pub fn parse(request: Request) -> Result<Self, ProtocolError> {
        let Request { method, params, .. } = request;
        if let Some(workspace) = WorkspaceMethod::from_wire_method(method.as_str()) {
            let WorkspaceCall { id, params } = params_of(method.as_str(), params)?;
            return Ok(Self::Workspace {
                method: workspace,
                id,
                params,
            });
        }
        let name = method.as_str();
        Ok(match name.parse::<DaemonMethod>()? {
            DaemonMethod::Hello => Self::Hello,
            DaemonMethod::Workspaces => Self::Workspaces,
            DaemonMethod::Attach => Self::Attach(params_of(name, params)?),
            DaemonMethod::Detach => Self::Detach(params_of(name, params)?),
            DaemonMethod::Reload => Self::Reload(params_of(name, params)?),
            DaemonMethod::Subscribe => Self::Subscribe(params_of(name, params)?),
            DaemonMethod::Unsubscribe => Self::Unsubscribe(params_of(name, params)?),
            DaemonMethod::Shutdown => Self::Shutdown,
            DaemonMethod::Register => Self::Register(params_of(name, params)?),
        })
    }
}

fn params_of<T: DeserializeOwned>(method: &str, params: Option<Value>) -> Result<T, ProtocolError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|source| {
        ProtocolError::InvalidParams {
            method: method.to_owned(),
            source,
        }
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_json::{assert_roundtrip, from_json, non_empty, to_json};
    use super::*;

    fn setup_draft() -> SetupDraftParams {
        SetupDraftParams {
            instructions: "do it".to_owned(),
            name: "demo".to_owned(),
            template: "basic".to_owned(),
        }
    }

    fn parsed(
        method: impl Into<NonEmptyString>,
        params: Option<Value>,
    ) -> Result<DaemonRequest, ProtocolError> {
        let request = Request::new(1, method);
        DaemonRequest::parse(match params {
            Some(params) => request.with_params(params),
            None => request,
        })
    }

    #[test]
    fn hello_result_uses_camel_case_keys() {
        let hello = HelloResult {
            artifacts: "/a".to_owned(),
            pid: 1,
            protocol: 1,
            started_at: "2026-01-01T00:00:00.000Z".to_owned(),
            state: "/s".to_owned(),
            version: "0.0.4".to_owned(),
        };

        assert_roundtrip(
            &hello,
            r#"{"artifacts":"/a","pid":1,"protocol":1,"startedAt":"2026-01-01T00:00:00.000Z","state":"/s","version":"0.0.4"}"#,
        );
    }

    #[test]
    fn attach_params_omit_absent_optionals() {
        let attach = AttachParams {
            root: None,
            setup: None,
            source: non_empty("./repo"),
        };

        assert_roundtrip(&attach, r#"{"source":"./repo"}"#);
    }

    #[test]
    fn attach_params_carry_root_and_setup() {
        let attach = AttachParams {
            root: Some(non_empty("/repo")),
            setup: Some(setup_draft()),
            source: non_empty("./repo"),
        };

        assert_roundtrip(
            &attach,
            r#"{"root":"/repo","setup":{"instructions":"do it","name":"demo","template":"basic"},"source":"./repo"}"#,
        );
    }

    #[test]
    fn attach_params_require_a_source() {
        assert!(from_json::<AttachParams>(r#"{"root":"/repo"}"#).is_err());
    }

    #[test]
    fn attach_params_reject_empty_source_and_root() {
        assert!(from_json::<AttachParams>(r#"{"source":""}"#).is_err());
        assert!(from_json::<AttachParams>(r#"{"root":"","source":"."}"#).is_err());
    }

    #[test]
    fn attach_params_reject_null_optionals() {
        assert!(from_json::<AttachParams>(r#"{"root":null,"source":"."}"#).is_err());
    }

    #[test]
    fn workspace_id_and_register_params_reject_empty_values() {
        assert!(from_json::<WorkspaceIdParams>(r#"{"id":""}"#).is_err());
        assert!(from_json::<RegisterParams>(r#"{"token":""}"#).is_err());
    }

    #[test]
    fn workspace_id_and_register_params_roundtrip() {
        assert_roundtrip(
            &WorkspaceIdParams {
                id: non_empty("w1"),
            },
            r#"{"id":"w1"}"#,
        );
        assert_roundtrip(
            &RegisterParams {
                token: non_empty("t"),
            },
            r#"{"token":"t"}"#,
        );
    }

    #[test]
    fn workspace_summary_writes_null_config_and_omits_error_and_pid() {
        let summary = WorkspaceSummary {
            config: None,
            error: None,
            id: "w1".to_owned(),
            pid: None,
            root: "/repo".to_owned(),
            state: WorkspaceState::Starting,
        };

        assert_roundtrip(
            &summary,
            r#"{"config":null,"id":"w1","root":"/repo","state":"starting"}"#,
        );
    }

    #[test]
    fn workspace_summary_carries_every_field() {
        let summary = WorkspaceSummary {
            config: Some("/repo/marbles.config.ts".to_owned()),
            error: Some("broke".to_owned()),
            id: "w1".to_owned(),
            pid: Some(7),
            root: "/repo".to_owned(),
            state: WorkspaceState::Failed,
        };

        assert_roundtrip(
            &summary,
            r#"{"config":"/repo/marbles.config.ts","error":"broke","id":"w1","pid":7,"root":"/repo","state":"failed"}"#,
        );
    }

    #[test]
    fn workspace_summary_requires_the_config_key() {
        assert!(
            from_json::<WorkspaceSummary>(r#"{"id":"w1","root":"/r","state":"ready"}"#).is_err()
        );
    }

    #[test]
    fn workspace_summary_rejects_null_error() {
        assert!(
            from_json::<WorkspaceSummary>(
                r#"{"config":null,"error":null,"id":"w1","root":"/r","state":"ready"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn workspace_states_use_lowercase_names() {
        let states = [
            WorkspaceState::Starting,
            WorkspaceState::Ready,
            WorkspaceState::Reloading,
            WorkspaceState::Failed,
            WorkspaceState::Stopped,
        ];

        assert_eq!(
            to_json(&states),
            r#"["starting","ready","reloading","failed","stopped"]"#
        );
        assert!(from_json::<WorkspaceState>(r#""Ready""#).is_err());
    }

    #[test]
    fn parameterless_daemon_methods_ignore_their_params() {
        assert_eq!(
            parsed(DaemonMethod::Hello, None).ok(),
            Some(DaemonRequest::Hello)
        );
        assert_eq!(
            parsed(DaemonMethod::Workspaces, Some(json!({ "x": 1 }))).ok(),
            Some(DaemonRequest::Workspaces)
        );
        assert_eq!(
            parsed(DaemonMethod::Shutdown, None).ok(),
            Some(DaemonRequest::Shutdown)
        );
    }

    #[test]
    fn daemon_methods_parse_their_params() {
        let id = || WorkspaceIdParams {
            id: non_empty("w1"),
        };

        assert_eq!(
            parsed(DaemonMethod::Attach, Some(json!({ "source": "." }))).ok(),
            Some(DaemonRequest::Attach(AttachParams {
                root: None,
                setup: None,
                source: non_empty("."),
            }))
        );
        assert_eq!(
            parsed(DaemonMethod::Detach, Some(json!({ "id": "w1" }))).ok(),
            Some(DaemonRequest::Detach(id()))
        );
        assert_eq!(
            parsed(DaemonMethod::Reload, Some(json!({ "id": "w1" }))).ok(),
            Some(DaemonRequest::Reload(id()))
        );
        assert_eq!(
            parsed(DaemonMethod::Subscribe, Some(json!({ "id": "w1" }))).ok(),
            Some(DaemonRequest::Subscribe(id()))
        );
        assert_eq!(
            parsed(DaemonMethod::Unsubscribe, Some(json!({ "id": "w1" }))).ok(),
            Some(DaemonRequest::Unsubscribe(id()))
        );
        assert_eq!(
            parsed(DaemonMethod::Register, Some(json!({ "token": "t" }))).ok(),
            Some(DaemonRequest::Register(RegisterParams {
                token: non_empty("t")
            }))
        );
    }

    #[test]
    fn missing_or_empty_params_are_invalid() {
        assert!(matches!(
            parsed(DaemonMethod::Attach, None),
            Err(ProtocolError::InvalidParams { method, .. }) if method == "attach"
        ));
        assert!(matches!(
            parsed(DaemonMethod::Detach, Some(json!({ "id": "" }))),
            Err(ProtocolError::InvalidParams { .. })
        ));
        assert!(matches!(
            parsed(WorkspaceMethod::GetRun, Some(json!({ "runId": "r1" }))),
            Err(ProtocolError::InvalidParams { method, .. }) if method == "workspace.getRun"
        ));
        assert!(matches!(
            parsed(WorkspaceMethod::GetRun, Some(json!([1]))),
            Err(ProtocolError::InvalidParams { .. })
        ));
    }

    #[test]
    fn unknown_methods_are_refused() {
        assert!(matches!(
            parsed(non_empty("workspace.unknown"), None),
            Err(ProtocolError::UnknownMethod(name)) if name == "workspace.unknown"
        ));
        assert!(matches!(
            parsed(non_empty("getRun"), None),
            Err(ProtocolError::UnknownMethod(_))
        ));
    }

    #[test]
    fn workspace_methods_take_the_id_and_keep_the_rest_in_order() {
        let params = json!({ "zeta": 1, "id": "w1", "alpha": { "y": 2, "b": 3 }, "mid": null });

        let Ok(DaemonRequest::Workspace { method, id, params }) =
            parsed(WorkspaceMethod::CancelRun, Some(params))
        else {
            panic!("a workspace call should parse");
        };
        assert_eq!(method, WorkspaceMethod::CancelRun);
        assert_eq!(id, non_empty("w1"));
        assert_eq!(
            Value::Object(params).to_string(),
            r#"{"zeta":1,"alpha":{"y":2,"b":3},"mid":null}"#
        );
    }
}
