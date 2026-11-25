use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

use super::super::launcher::{GenerationExit, GenerationLauncher, SpawnSpec, SpawnedGeneration};
use super::super::workspace::workspace_id;
use crate::channel::{self, ChannelEvent, ChannelHandle};
use crate::identity::ProcessIdentity;
use crate::protocol::{
    DaemonMethod, GenerationMethod, NonEmptyString, Request, Response, WireError,
};

pub(super) const MOCK_PID_BASE: u32 = 5_000_000;

#[derive(Debug, Clone)]
pub(super) enum Answer {
    Echo,
    Value(Value),
    Retiring,
    Fail(String),
    Silent,
}

#[derive(Debug, Clone, Default)]
pub(super) struct Plan {
    pub(super) fail_load: BTreeMap<String, String>,
    pub(super) fail_start: Option<String>,
    pub(super) reads_before_load: Vec<(String, String)>,
    pub(super) linger_when_retired: bool,
    pub(super) answers: HashMap<String, VecDeque<Answer>>,
}

impl Plan {
    pub(super) fn answering(
        mut self,
        method: &str,
        answers: impl IntoIterator<Item = Answer>,
    ) -> Self {
        self.answers
            .insert(method.to_owned(), answers.into_iter().collect());
        self
    }

    pub(super) fn lingering(self) -> Self {
        Self {
            linger_when_retired: true,
            ..self
        }
    }

    pub(super) fn failing_start(self, error: &str) -> Self {
        Self {
            fail_start: Some(error.to_owned()),
            ..self
        }
    }

    pub(super) fn reading_before_load(mut self, root: &str, file: &str) -> Self {
        self.reads_before_load
            .push((root.to_owned(), file.to_owned()));
        self
    }

    pub(super) fn failing_load(mut self, root: &str, error: &str) -> Self {
        self.fail_load.insert(root.to_owned(), error.to_owned());
        self
    }

    fn next_answer(&mut self, method: &str, otherwise: Answer) -> Answer {
        match self.answers.get_mut(method) {
            Some(queued) if queued.len() > 1 => queued.pop_front().unwrap_or(otherwise),
            Some(queued) => queued.front().cloned().unwrap_or(otherwise),
            None => otherwise,
        }
    }
}

#[derive(Debug)]
enum Control {
    Crash,
    Notify(&'static str, Value),
}

#[derive(Debug, Default)]
pub(super) struct Seen {
    pub(super) token: Option<NonEmptyString>,
    pub(super) requests: Vec<(String, Value)>,
    pub(super) channel: Option<ChannelHandle>,
    pub(super) exited: Option<GenerationExit>,
    controls: Option<mpsc::UnboundedSender<Control>>,
}

#[derive(Default)]
struct WorldState {
    known: Vec<String>,
    spawn_failures: usize,
    spawn_attempts: usize,
    log: Vec<(u64, String)>,
    plans: HashMap<u64, Plan>,
    seen: BTreeMap<u64, Seen>,
}

#[derive(Clone, Default)]
pub(super) struct World(Arc<Mutex<WorldState>>);

impl World {
    fn lock(&self) -> MutexGuard<'_, WorldState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn register_root(&self, root: &str) {
        let mut world = self.lock();
        if !world.known.iter().any(|known| known == root) {
            world.known.push(root.to_owned());
        }
    }

    pub(super) fn plan(&self, number: u64, plan: Plan) {
        self.lock().plans.insert(number, plan);
    }

    pub(super) fn spawned(&self) -> usize {
        self.lock().seen.len()
    }

    pub(super) fn fail_spawns(&self, times: usize) {
        self.lock().spawn_failures = times;
    }

    pub(super) fn spawn_attempts(&self) -> usize {
        self.lock().spawn_attempts
    }

    pub(super) fn methods(&self, number: u64) -> Vec<String> {
        self.lock()
            .seen
            .get(&number)
            .map(|seen| {
                seen.requests
                    .iter()
                    .map(|(method, _)| method.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(super) fn params_of(&self, number: u64, method: &str) -> Vec<Value> {
        self.lock()
            .seen
            .get(&number)
            .map(|seen| {
                seen.requests
                    .iter()
                    .filter(|(asked, _)| asked == method)
                    .map(|(_, params)| params.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(super) fn exit_of(&self, number: u64) -> Option<GenerationExit> {
        self.lock()
            .seen
            .get(&number)
            .and_then(|seen| seen.exited.clone())
    }

    pub(super) fn token_of(&self, number: u64) -> Option<NonEmptyString> {
        self.lock()
            .seen
            .get(&number)
            .and_then(|seen| seen.token.clone())
    }

    pub(super) fn channel_of(&self, number: u64) -> Option<ChannelHandle> {
        self.lock()
            .seen
            .get(&number)
            .and_then(|seen| seen.channel.clone())
    }

    pub(super) fn crash(&self, number: u64) {
        self.control(number, Control::Crash);
    }

    pub(super) fn notify(&self, number: u64, method: &'static str, params: Value) {
        self.control(number, Control::Notify(method, params));
    }

    fn control(&self, number: u64, control: Control) {
        let controls = self
            .lock()
            .seen
            .get(&number)
            .and_then(|seen| seen.controls.clone());
        if let Some(controls) = controls {
            let _ = controls.send(control);
        }
    }

    pub(super) fn log(&self) -> Vec<(u64, String)> {
        self.lock().log.clone()
    }

    fn record(&self, number: u64, request: &Request) {
        let mut world = self.lock();
        world.log.push((number, request.method.as_str().to_owned()));
        let seen = world.seen.entry(number).or_default();
        seen.requests.push((
            request.method.as_str().to_owned(),
            request.params.clone().unwrap_or(Value::Null),
        ));
    }

    fn reply(&self, number: u64, request: &Request) -> Reply {
        self.record(number, request);
        let mut world = self.lock();
        let known = world.known.clone();
        let plan = world.plans.entry(number).or_default();
        let method = request.method.as_str();
        let params = request.params.clone().unwrap_or(Value::Null);
        let answer = match method.parse::<GenerationMethod>() {
            Ok(GenerationMethod::Load) => {
                let reads: Vec<Value> = plan
                    .reads_before_load
                    .iter()
                    .map(|(root, file)| json!({ "file": file, "readAt": u64::MAX, "root": root }))
                    .collect();
                let response = Response::ok(
                    request.id,
                    json!({
                        "identity": identity(number),
                        "loads": loads(&known, &plan.fail_load),
                    }),
                );
                return Reply::Notified(reads, response);
            }
            Ok(GenerationMethod::Start) => match &plan.fail_start {
                Some(error) => Answer::Fail(error.clone()),
                None => Answer::Value(json!({ "loads": loads(&known, &BTreeMap::new()) })),
            },
            Ok(GenerationMethod::Host) => {
                let root = params["root"].as_str().unwrap_or_default().to_owned();
                Answer::Value(json!({
                    "config": params["config"].clone(),
                    "id": workspace_id(&root),
                    "root": root,
                }))
            }
            Ok(GenerationMethod::Unhost) => plan.next_answer(method, Answer::Value(Value::Null)),
            Ok(GenerationMethod::Stop) => return Reply::Exit(Response::empty(request.id)),
            Ok(GenerationMethod::Retire) if !plan.linger_when_retired => {
                return Reply::Exit(Response::empty(request.id));
            }
            Ok(GenerationMethod::TakeHanded) => {
                plan.next_answer(method, Answer::Value(json!(true)))
            }
            Ok(GenerationMethod::LiveWork) => plan.next_answer(method, Answer::Value(json!([]))),
            Ok(GenerationMethod::Retire) => plan.next_answer(method, Answer::Value(Value::Null)),
            _ => plan.next_answer(method, Answer::Echo),
        };
        Reply::Respond(match answer {
            Answer::Echo => Response::ok(
                request.id,
                json!({ "generation": number, "method": method, "params": params }),
            ),
            Answer::Value(value) => Response::ok(request.id, value),
            Answer::Retiring => Response::err(
                request.id,
                WireError::named("EngineRetiringError", "the engine is retiring"),
            ),
            Answer::Fail(message) => Response::err(request.id, WireError::new(message)),
            Answer::Silent => return Reply::Silent,
        })
    }
}

enum Reply {
    Respond(Response),
    Notified(Vec<Value>, Response),
    Exit(Response),
    Silent,
}

fn identity(number: u64) -> ProcessIdentity {
    ProcessIdentity {
        pid: mock_pid(number),
        started: Some(format!("mock:{number}")),
    }
}

pub(super) fn mock_pid(number: u64) -> u32 {
    MOCK_PID_BASE + u32::try_from(number).unwrap_or(0)
}

fn loads(known: &[String], failing: &BTreeMap<String, String>) -> Vec<Value> {
    known
        .iter()
        .map(|root| match failing.get(root) {
            Some(error) => json!({ "error": error, "root": root }),
            None => json!({ "id": workspace_id(root), "root": root }),
        })
        .collect()
}

#[derive(Clone, Default)]
pub(super) struct MockLauncher {
    pub(super) world: World,
}

impl GenerationLauncher for MockLauncher {
    fn spawn(&self, spec: SpawnSpec) -> Result<SpawnedGeneration, io::Error> {
        let (exit, exited) = oneshot::channel();
        let (_lines, lines) = mpsc::channel(1);
        let (controls, controlled) = mpsc::unbounded_channel();
        {
            let mut world = self.world.lock();
            world.spawn_attempts += 1;
            if world.spawn_failures > 0 {
                world.spawn_failures -= 1;
                return Err(io::Error::other("the process table is full"));
            }
            let seen = world.seen.entry(spec.number).or_default();
            seen.token = Some(spec.token.clone());
            seen.controls = Some(controls);
        }
        tokio::spawn(run(self.world.clone(), spec, controlled, exit));
        Ok(SpawnedGeneration {
            pid: None,
            spawned_as: None,
            exited,
            lines,
        })
    }
}

async fn run(
    world: World,
    spec: SpawnSpec,
    controlled: mpsc::UnboundedReceiver<Control>,
    exit: oneshot::Sender<GenerationExit>,
) {
    let ended = serve(&world, &spec, controlled).await;
    if let Some(seen) = world.lock().seen.get_mut(&spec.number) {
        seen.exited = Some(ended.clone());
    }
    let _ = exit.send(ended);
}

async fn serve(
    world: &World,
    spec: &SpawnSpec,
    mut controlled: mpsc::UnboundedReceiver<Control>,
) -> GenerationExit {
    let Ok(stream) = UnixStream::connect(&spec.socket).await else {
        return unclean("it could not dial the daemon");
    };
    let (channel, mut events) = channel::open(stream);
    if let Some(seen) = world.lock().seen.get_mut(&spec.number) {
        seen.channel = Some(channel.clone());
    }
    let token = json!({ "token": spec.token.as_str() });
    if channel
        .request(DaemonMethod::Register, Some(token))
        .await
        .is_err()
    {
        return unclean("its registration was refused");
    }
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Some(ChannelEvent::Request(request)) => match world.reply(spec.number, &request) {
                    Reply::Respond(response) => {
                        let _ = channel.respond(response);
                    }
                    Reply::Notified(reads, response) => {
                        for read in reads {
                            if let Ok(method) = NonEmptyString::try_from("read".to_owned()) {
                                let _ = channel.notify(method, Some(read));
                            }
                        }
                        let _ = channel.respond(response);
                    }
                    Reply::Exit(response) => {
                        let _ = channel.respond(response);
                        channel.close();
                        return clean("it finished");
                    }
                    Reply::Silent => {}
                },
                Some(ChannelEvent::Notification(_)) => {}
                Some(ChannelEvent::Closed(_)) | None => return clean("it was orphaned"),
            },
            control = controlled.recv() => match control {
                Some(Control::Crash) | None => {
                    channel.close();
                    return unclean("it crashed");
                }
                Some(Control::Notify(method, params)) => {
                    let method = NonEmptyString::try_from(method.to_owned());
                    if let Ok(method) = method {
                        let _ = channel.notify(method, Some(params));
                    }
                }
            },
        }
    }
}

fn clean(reason: &str) -> GenerationExit {
    GenerationExit {
        clean: true,
        reason: reason.to_owned(),
    }
}

fn unclean(reason: &str) -> GenerationExit {
    GenerationExit {
        clean: false,
        reason: reason.to_owned(),
    }
}
