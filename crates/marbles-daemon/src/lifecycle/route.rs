use std::collections::BTreeMap;

use serde_json::Value;

use crate::protocol::{
    DaemonMethod, DaemonRequest, HelloResult, Request, Response, WireError, WorkspaceMethod,
    WorkspaceSummary,
};

const STOPPING: &str = "the Marbles process is stopping; retry once it has exited";
const UNKNOWN_TOKEN: &str = "no engine generation was spawned with this token";

pub(super) struct View<'a> {
    pub(super) hello: &'a HelloResult,
    pub(super) workspaces: &'a BTreeMap<String, WorkspaceSummary>,
    pub(super) stopping: bool,
}

#[derive(Debug, PartialEq)]
pub(super) enum Effect {
    Nothing,
    Subscribe(String),
    Unsubscribe(String),
    Shutdown,
}

#[derive(Debug, PartialEq)]
pub(super) struct Routed {
    pub(super) response: Response,
    pub(super) effect: Effect,
}

pub(super) fn route(request: Request, view: &View<'_>) -> Routed {
    let id = request.id;
    if view.stopping && starts_work(&request) {
        return refused(id, STOPPING);
    }
    let request = match DaemonRequest::parse(request) {
        Ok(request) => request,
        Err(error) => return refused(id, error.to_string()),
    };
    match request {
        DaemonRequest::Hello => encoded(id, view.hello),
        DaemonRequest::Workspaces => {
            let summaries: Vec<&WorkspaceSummary> = view.workspaces.values().collect();
            encoded(id, &summaries)
        }
        DaemonRequest::Subscribe(params) => acknowledged(id, Effect::Subscribe(params.id.into())),
        DaemonRequest::Unsubscribe(params) => {
            acknowledged(id, Effect::Unsubscribe(params.id.into()))
        }
        DaemonRequest::Shutdown => acknowledged(id, Effect::Shutdown),
        DaemonRequest::Register(_) => refused(id, UNKNOWN_TOKEN),
        DaemonRequest::Attach(params) => refused(
            id,
            format!(
                "cannot attach {}: no engine generation runs to host it",
                params.source
            ),
        ),
        DaemonRequest::Detach(params) => refused(
            id,
            unserved(view, params.id.as_str(), DaemonMethod::Detach.as_str()),
        ),
        DaemonRequest::Reload(params) => refused(
            id,
            unserved(view, params.id.as_str(), DaemonMethod::Reload.as_str()),
        ),
        DaemonRequest::Workspace {
            method,
            id: workspace,
            ..
        } => refused(id, unserved(view, workspace.as_str(), method.wire_name())),
    }
}

fn starts_work(request: &Request) -> bool {
    let method = request.method.as_str();
    match WorkspaceMethod::from_wire_method(method) {
        Some(WorkspaceMethod::Tasks) => command_kind(request.params.as_ref()) == Some("change"),
        Some(workspace) => workspace.dispatches_work(),
        None => matches!(
            method.parse(),
            Ok(DaemonMethod::Attach | DaemonMethod::Reload)
        ),
    }
}

fn command_kind(params: Option<&Value>) -> Option<&str> {
    params?.get("command")?.get("kind")?.as_str()
}

fn unserved(view: &View<'_>, workspace: &str, method: &str) -> String {
    if view.workspaces.contains_key(workspace) {
        format!("workspace {workspace} has no running engine generation to answer \"{method}\"")
    } else {
        format!("no workspace \"{workspace}\" is hosted")
    }
}

fn encoded(id: u64, result: &impl serde::Serialize) -> Routed {
    match serde_json::to_value(result) {
        Ok(result) => Routed {
            response: Response::ok(id, result),
            effect: Effect::Nothing,
        },
        Err(error) => refused(id, format!("the reply could not be encoded: {error}")),
    }
}

fn acknowledged(id: u64, effect: Effect) -> Routed {
    Routed {
        response: Response::empty(id),
        effect,
    }
}

fn refused(id: u64, message: impl Into<String>) -> Routed {
    Routed {
        response: Response::err(id, WireError::new(message)),
        effect: Effect::Nothing,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::protocol::{NonEmptyString, WorkspaceState};

    fn hello() -> HelloResult {
        HelloResult {
            artifacts: "/h/artifacts".to_owned(),
            pid: 7,
            protocol: 1,
            started_at: "2026-01-01T00:00:00.000Z".to_owned(),
            state: "/h/marbles".to_owned(),
            version: "0.0.4".to_owned(),
        }
    }

    fn hosted() -> BTreeMap<String, WorkspaceSummary> {
        BTreeMap::from([(
            "w1".to_owned(),
            WorkspaceSummary {
                config: None,
                error: None,
                id: "w1".to_owned(),
                pid: None,
                root: "/repo".to_owned(),
                state: WorkspaceState::Ready,
            },
        )])
    }

    fn routed(method: &str, params: Option<Value>, stopping: bool) -> Routed {
        let hello = hello();
        let workspaces = hosted();
        let method = NonEmptyString::try_from(method.to_owned()).expect("a method");
        let request = Request {
            id: 3,
            method,
            params,
        };
        route(
            request,
            &View {
                hello: &hello,
                workspaces: &workspaces,
                stopping,
            },
        )
    }

    fn error_of(routed: &Routed) -> Option<&str> {
        routed
            .response
            .error
            .as_ref()
            .map(|error| error.message.as_str())
    }

    #[test]
    fn hello_answers_with_the_hello_result() {
        let routed = routed("hello", None, false);

        assert_eq!(
            routed.response.result,
            Some(json!({
                "artifacts": "/h/artifacts",
                "pid": 7,
                "protocol": 1,
                "startedAt": "2026-01-01T00:00:00.000Z",
                "state": "/h/marbles",
                "version": "0.0.4",
            }))
        );
        assert_eq!(routed.effect, Effect::Nothing);
    }

    #[test]
    fn workspaces_lists_the_hosted_summaries() {
        assert_eq!(
            routed("workspaces", None, false).response.result,
            Some(json!([{ "config": null, "id": "w1", "root": "/repo", "state": "ready" }]))
        );
    }

    #[test]
    fn subscriptions_and_shutdown_acknowledge_with_an_effect() {
        let params = || Some(json!({ "id": "w1" }));

        assert_eq!(
            routed("subscribe", params(), false),
            Routed {
                response: Response::empty(3),
                effect: Effect::Subscribe("w1".to_owned()),
            }
        );
        assert_eq!(
            routed("unsubscribe", params(), false).effect,
            Effect::Unsubscribe("w1".to_owned())
        );
        assert_eq!(
            routed("shutdown", None, true),
            Routed {
                response: Response::empty(3),
                effect: Effect::Shutdown,
            }
        );
    }

    #[test]
    fn work_is_refused_while_stopping() {
        let refusals = [
            ("attach", json!({ "source": "." })),
            ("reload", json!({ "id": "w1" })),
            ("workspace.launch", json!({ "id": "w1" })),
            ("workspace.roll", json!({ "id": "w1" })),
            ("workspace.resume", json!({ "id": "w1" })),
            ("workspace.dispatchAgent", json!({ "id": "w1" })),
            ("workspace.dispatchWorkflow", json!({ "id": "w1" })),
            (
                "workspace.tasks",
                json!({ "id": "w1", "command": { "kind": "change" } }),
            ),
        ];

        for (method, params) in refusals {
            let routed = routed(method, Some(params), true);
            assert_eq!(error_of(&routed), Some(STOPPING), "{method}");
        }
    }

    #[test]
    fn reads_are_still_answered_while_stopping() {
        assert_eq!(error_of(&routed("hello", None, true)), None);
        assert_ne!(
            error_of(&routed("detach", Some(json!({ "id": "w1" })), true)),
            Some(STOPPING)
        );
        assert_ne!(
            error_of(&routed(
                "workspace.tasks",
                Some(json!({ "id": "w1", "command": { "kind": "list" } })),
                true
            )),
            Some(STOPPING)
        );
    }

    #[test]
    fn unhosted_work_names_what_is_missing() {
        assert_eq!(
            error_of(&routed("register", Some(json!({ "token": "t" })), false)),
            Some(UNKNOWN_TOKEN)
        );
        assert_eq!(
            error_of(&routed(
                "attach",
                Some(json!({ "source": "./repo" })),
                false
            )),
            Some("cannot attach ./repo: no engine generation runs to host it")
        );
        assert_eq!(
            error_of(&routed("detach", Some(json!({ "id": "w9" })), false)),
            Some("no workspace \"w9\" is hosted")
        );
        assert_eq!(
            error_of(&routed(
                "workspace.getRun",
                Some(json!({ "id": "w1" })),
                false
            )),
            Some("workspace w1 has no running engine generation to answer \"workspace.getRun\"")
        );
        assert_eq!(
            error_of(&routed("reload", Some(json!({ "id": "w1" })), false)),
            Some("workspace w1 has no running engine generation to answer \"reload\"")
        );
    }

    #[test]
    fn protocol_errors_become_replies() {
        assert_eq!(
            error_of(&routed("nope", None, false)),
            Some("\"nope\" is not a known method")
        );
        assert!(
            error_of(&routed("subscribe", None, false))
                .is_some_and(|message| message.starts_with("\"subscribe\" was sent invalid params"))
        );
    }
}
