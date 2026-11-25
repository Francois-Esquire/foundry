use serde_json::Value;

use super::QueuedRun;
use crate::identity::ProcessIdentity;

const QUEUED: &str = "queued";
const RUNNING: &str = "running";

pub(super) fn queued_in_order(bodies: &[String]) -> Vec<QueuedRun> {
    let mut queued: Vec<(f64, QueuedRun)> = bodies
        .iter()
        .filter_map(|body| serde_json::from_str::<Value>(body).ok())
        .filter_map(|run| {
            let state = run.get("state")?;
            if state.get("kind")?.as_str()? != QUEUED {
                return None;
            }
            let queued_at = state.get("queuedAt")?.as_f64()?;
            let owner = identity_of(state.get("owner")?)?;
            let id = run.get("id")?.as_str()?.to_owned();
            Some((queued_at, QueuedRun { id, owner }))
        })
        .collect();
    queued.sort_by(|one, other| one.0.total_cmp(&other.0));
    queued.into_iter().map(|(_, run)| run).collect()
}

pub(super) fn owner_of_run(body: &str) -> Option<ProcessIdentity> {
    let run: Value = serde_json::from_str(body).ok()?;
    let state = run.get("state")?;
    match state.get("kind")?.as_str()? {
        RUNNING => identity_of(state.get("lease")?.get("owner")?),
        QUEUED => identity_of(state.get("owner")?),
        _ => None,
    }
}

pub(super) fn state_of_run(body: &str) -> Option<String> {
    let run: Value = serde_json::from_str(body).ok()?;
    Some(run.get("state")?.get("kind")?.as_str()?.to_owned())
}

fn identity_of(owner: &Value) -> Option<ProcessIdentity> {
    let pid = u32::try_from(owner.get("pid")?.as_u64()?).ok()?;
    let started = match owner.get("started") {
        None | Some(Value::Null) => None,
        Some(started) => Some(started.as_str()?.to_owned()),
    };
    Some(ProcessIdentity { pid, started })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn body(value: &Value) -> String {
        value.to_string()
    }

    #[test]
    fn queued_runs_with_an_owner_come_in_the_order_they_were_queued() {
        let bodies = [
            body(
                &json!({ "id": "late", "state": { "kind": "queued", "queuedAt": 30, "owner": { "pid": 7, "started": "a" } } }),
            ),
            body(
                &json!({ "id": "early", "state": { "kind": "queued", "queuedAt": 10, "owner": { "pid": 8, "started": null, "instanceId": "x" } } }),
            ),
            body(&json!({ "id": "unowned", "state": { "kind": "queued", "queuedAt": 5 } })),
            body(
                &json!({ "id": "busy", "state": { "kind": "running", "lease": { "owner": { "pid": 9, "started": "b" } } } }),
            ),
            "not json".to_owned(),
        ];

        let queued = queued_in_order(&bodies);

        assert_eq!(
            queued,
            [
                QueuedRun {
                    id: "early".to_owned(),
                    owner: ProcessIdentity {
                        pid: 8,
                        started: None
                    },
                },
                QueuedRun {
                    id: "late".to_owned(),
                    owner: ProcessIdentity {
                        pid: 7,
                        started: Some("a".to_owned())
                    },
                },
            ]
        );
    }

    #[test]
    fn a_run_is_owned_by_its_lease_while_running_and_its_owner_while_queued() {
        let running = body(
            &json!({ "id": "r", "state": { "kind": "running", "lease": { "claimedAt": 1, "owner": { "pid": 9, "started": "b" } } } }),
        );
        let queued = body(
            &json!({ "id": "q", "state": { "kind": "queued", "queuedAt": 1, "owner": { "pid": 3, "started": null } } }),
        );
        let done = body(&json!({ "id": "d", "state": { "kind": "complete" } }));

        assert_eq!(
            owner_of_run(&running),
            Some(ProcessIdentity {
                pid: 9,
                started: Some("b".to_owned())
            })
        );
        assert_eq!(
            owner_of_run(&queued),
            Some(ProcessIdentity {
                pid: 3,
                started: None
            })
        );
        assert_eq!(owner_of_run(&done), None);
        assert_eq!(state_of_run(&done).as_deref(), Some("complete"));
    }
}
