# Task pipeline

Tasks are the entry point. Give a task the `pipeline` tag (create it with
the tag, or add the tag later) and the workspace's observer:

1. refines it: a refiner agent with explicitly chosen skills reads the
   repository and records requirements, constraints, acceptance criteria,
   and unknowns;
2. prepares it, only when the rule below holds, or asks its consequential
   questions and waits;
3. routes it once `tasks.ready()` offers it: a small Codex model chooses one
   destination and that destination's allowed input, or asks for
   clarification;
4. runs the destination with the task as its context, and records what it
   returned. The task stays `active`, holding its dependents back, until you
   accept the result; only acceptance completes it.

Refinement settles what is asked. Routing settles how it is run. Untagged
tasks are never touched.

The code is in `task-pipeline/`: `state.ts` (the stored state and its
transitions, pure), `refine.ts`, `route.ts`, `pipeline.ts` (the observer and
steps), and `destinations.ts` (this repository's destinations).
`.foundry/marbles/task-pipeline.ts` registers it here.

## Use

```ts
import { skills } from "@foundry.sh/marbles";
import { standardDestinations } from "./task-pipeline/destinations";
import { taskPipeline } from "./task-pipeline/pipeline";

taskPipeline({
  destinations: standardDestinations(),
  // Optional. load() reads the global skills and the `skills/` folder beside
  // the config (`.foundry/marbles/skills/` here), not the repository's root.
  refiner: { skills: skills.load().pick("domain-modeling") },
  router: { model: "<exact Codex model id>" }, // or MARBLES_PIPELINE_ROUTER_MODEL
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `destinations` | required | Named steps or workflows a task can be routed to. |
| `tag` | `pipeline` | Only tasks with this tag enter. |
| `refiner` | engine default route, `task-refinement` skill | `provider`, `model`, `skills`. Skills are only the ones named. |
| `router` | provider `codex`, no model | `model` falls back to `MARBLES_PIPELINE_ROUTER_MODEL`. With neither, routing is `blocked`. |
| `turnTimeoutMs` | 5 minutes | Limit for each refinement or routing turn. |

Call `taskPipeline` once per workspace. It registers the steps
`task-pipeline-refine` and `task-pipeline-attempt` (launched by the observer),
`task-pipeline-request` and `task-pipeline-reconcile` (launched by you).

### Destinations

`destination({ definition, description, choose, build })` adds one. The
router sees its name, its description, and the JSON schema of `choose`: the
only fields it may set. `build(brief, chosen)` makes the definition's input
from the task and those fields. The router cannot set the spec, the checkout,
or anything else `choose` leaves out.

`standardDestinations({ worktree })` offers:

| Name | Runs | Router may choose |
| --- | --- | --- |
| `adversarial-review` | The existing two-axis review, the task as its spec. Reads only. | `base`, `includeWorkingTree` |
| `develop-round` | Implement, then review (`development.ts`). Edits files. | nothing |
| `task-research` | A read-only research turn on the task. | nothing |

Registering these also makes `develop-round` and its `implement` step
launchable by name (CLI, dashboard, MCP `dispatch_workflow`) in that
workspace. They edit the working tree.

### Routing model

Set `MARBLES_PIPELINE_ROUTER_MODEL` (declared in the root `.env.schema`,
loaded by Varlock) or `router.model` to an exact id your Codex CLI lists.
The pipeline never picks one for you. The value is passed to Codex as it is.

## The stored state

Everything is kept in `metadata.pipeline` on the task: `stage`, the current
`attempt` (`id`, `kind`, `owner`, `runId`, and `parked` while its run waits
on a question), the `refinement`, the `route`
(`workflow`, `input`, `reason`, `source`, and for model decisions `model`,
`provider`, `session`), the last `outcome`, open `questions`, and a `history`
of every attempt with its run id.

| Stage | Means | Observer |
| --- | --- | --- |
| `intake` | New, or sent back to be refined. | Refines it. |
| `refining`, `routing`, `running` | An attempt is in flight. | Ignores it. |
| `needs-clarification` | Refinement or routing asked `questions`. | Ignores it. |
| `prepared` | Refined and accepted. | Routes it when `ready()` offers it. |
| `awaiting-acceptance` | The destination returned; `outcome.output` holds its start, `outcome.runId` the run. The task stays `active`. | Ignores it. |
| `accepted` | You accepted the result; the task is `completed`. `outcome` still holds the run's result. | Ignores it. |
| `failed` | Refinement, routing, or the destination threw, or its run was cancelled here. The task is reopened. | Ignores it. |
| `unsupported` | The router chose a name or input outside the destinations. | Ignores it. |
| `blocked` | No routing model is configured. | Ignores it. |
| `interrupted` | The process that held the attempt stopped. | Ignores it. |

A task is prepared only when the refiner says it is ready, there is at least
one requirement and one acceptance criterion, and no unknown is marked
consequential.

A task with no `metadata.pipeline` is not in the pipeline. The observer
enrolls one at `intake` from a change, never from what it finds on a pass:
a change that made the task open and tagged (created it so, tagged it, or
reopened it) while it has no state and no notes. Any other change enrolls
nothing, so a task left without its state never starts over by itself.
`task.update`
replaces `metadata` whole, so an update through the CLI or `change_tasks`
can drop the state. The observer then puts back the state that change
removed, history and attempt included, beside the new metadata; nothing is
refined, routed, or run again. It does so whether or not the task still has
the tag: a change that drops the state and removes the tag at once resets
nothing. An unreadable value under `pipeline` is treated the same way.
Nothing resets a task implicitly; to start it over on purpose, request
`refine`.

The state is put back, or the task enrolled, only at the task's current
version. Every change records the task's `updatedAt` before and after it.
When the task has changed since (a run left a note, or another write
landed first), the observer first writes what it owes onto the task, beside
the notes: `{ notes: [...], pending: { from, image } }` to put `image` back,
or `pending: { from, enroll: true }` to enroll it, where `from` is the
`updatedAt` of the change that asked. That write commits before the change
is recorded as delivered, so a host that stops in between leaves it on disk.
The observer decides it when it reaches the task's current version; its own
write of the pending is such a change, so it needs no later write by anyone
else, and after a restart the same observer finishes it. A pending is not a
state: nothing is refined, routed, or run from it, and every request but
`refine` refuses while a state is being put back.

Only a later change's offer replaces a pending, so when a new handler is
handed the whole history, an older drop never puts back a state a later
change replaced: the latest drop restores its own, and the run it records
is not dispatched again. An enrollment never replaces a state owed back:
tagging or reopening the task before the restore goes on from that state,
just as it does once the state is back. A change that gave the task a state supersedes an
older pending (the task has none now, so a later change dropped that state,
and that change's offer is the one to keep); the pending is left as
`{ from }`, owing nothing. An enrollment that no longer applies at the
current version (the task lost the tag, or has notes) is settled the same
way. An overwrite that drops a pending offers it again under its own
`from`.

These rules rest on the order Marbles delivers in: the observer is handed
each change only after it has completed every earlier one (see `observe`
in the API reference). If its write for a change fails, it is handed that
change again before any later one, so it never decides a pending at the
current version while an earlier change that would supersede or replace
that pending is still unhandled, however many writes fail. The `from`
comparisons cover what ordering leaves: a change handed again after its
work was done (a completion that was not saved, or a crash before it
was), and an edited observer that is handed the whole history again.

A run that writes while the state is missing (it began, started its
destination, parked, or ended in that window) cannot decide against the
task, so it leaves a note under `pipeline` instead: `{ notes: [...] }`, not
a state. When the observer puts the state back, it applies a note only if
that state still holds the note's attempt, for the note's run; a note from
an attempt since replaced, or another run of it, is discarded. A result
returned in that window is therefore recorded once, by the run that
produced it, and nothing runs again. Runs leave notes whether or not the
task has the tag. A task with notes and no state has a run still out, so
the tag never enrolls it; only `refine` does.

## Moving a task on

Launch `task-pipeline-request` (`marbles roll`, or MCP `dispatch_workflow`):

| Input | From | Does |
| --- | --- | --- |
| `{ action: "accept", taskId }` | `awaiting-acceptance` | Accept the result: `accepted`, and the task is completed, which unblocks its dependents. |
| `{ action: "refine", taskId }` | not in flight, or no readable state | Back to `intake`, after you clarified the task. Without readable state, enroll it afresh. |
| `{ action: "prepare", taskId }` | `needs-clarification` | Accept the refinement as it is. |
| `{ action: "retry", taskId }` | `awaiting-acceptance`, `failed`, `unsupported`, `blocked`, `interrupted` | Route again. After `awaiting-acceptance`, `failed` or `interrupted`, reuse the recorded route without asking the router. |
| `{ action: "reroute", taskId, workflow?, input?, reason? }` | the same, plus `needs-clarification`, `prepared` | Route again without the last route, or with the named destination. A named route is checked now. |
| `{ action: "abandon", taskId }` | an attempt parked on a question or paused | Give it up: `interrupted`, with the attempt dropped. Its run does nothing if it is answered or resumed later. |

`accept` and `abandon` settle where they are and start nothing, so they
apply with or without the tag. The others need the tag; they leave the task
`intake` or `prepared`, and the observer takes it from there. Requests on a
settled task are refused, and so is every request but `abandon` while an
attempt is in flight.

## Guarantees and limits

- **One claim per readiness.** The observer claims an attempt with a write
  conditioned on the task's `updatedAt` token. A redelivered or replayed
  change finds the task past `intake`/`prepared` and does nothing. The
  pipeline's own writes never move a task to those two stages, so its
  progress never dispatches.
- **One run per attempt.** The run records its run id on the attempt before
  doing anything. Another run for the same attempt, or for a replaced or
  abandoned one, does nothing.
- **A run goes on only from what was committed.** Every pipeline write
  returns the task as its last try left it: as committed, or as read when
  that try had nothing to write. A run refines, routes, or starts its
  destination only if that task's state shows its own attempt (id, run id,
  this instance as owner, not parked) in the right stage; the destination
  starts only from a state that shows this run's attempt `running`. That is
  the start this run just committed, or, when a resumed run replays its
  step, the one it committed before. What an earlier, conflicted try meant
  to write gives no permission. Neither does a note, a withdrawal, a refused
  start, or another attempt's state.
- **A start is checked when it commits.** Routing uses `tasks.ready()`, so a
  task waits for its dependencies and is routed when the last one settles,
  even though the task itself did not change. The write that marks it
  `running` and `active` is one batch whose `task.set_status` carries
  `requireReady`; the task store refuses it with `not_ready` unless the task
  is ready inside the same transaction. A dependency added at any moment
  before that commit, even one that leaves the task's `updatedAt` alone, is
  seen; the task goes back to `prepared` and runs once it is ready again. A
  conflict retries the whole batch, check included.
- **Returning is not acceptance.** A destination that returns leaves the
  task `awaiting-acceptance` and `active`: a `develop-round` whose reviewer
  reports a P1 is recorded with its findings, and its dependents stay
  blocked. Only `accept` completes the task. The run's result
  (`outcome.output`, `outcome.runId`, the history entry) is kept apart from
  the task's status and survives acceptance.
- **Questions and pauses park, they do not fail.** A question a refinement,
  routing, or destination turn asks (`ask.question`, an approval) suspends
  the run, and so does pausing a pipeline step or a destination's step from
  the dashboard (`engine.pause`) mid-turn. The pipeline marks its attempt
  `parked` and lets the suspension through. It tells a pause from a cancel
  by the run's signal: a pause aborts only the step's signal, while a
  cancel, a graceful stop, or a failure elsewhere in the run aborts the
  run's signal as well, and those are passed through unmarked. It records a
  failure only for real errors. The engine keeps a parked run across a
  graceful stop or a crash; the next host that can answer questions adopts
  it. Reconcile leaves a parked attempt alone, and `retry`, `reroute`,
  `refine`, and `accept` are refused while it is parked. Answering the
  question, or resuming the paused step, resumes the same run in whichever
  process holds it; that run takes the attempt over (clears `parked`,
  records this instance as owner) and finishes it.
- **The tag decides what starts, nothing else.** The claim, the run's
  first write, and the write that starts the destination each re-read the
  task, on every conflict retry too, and go on only while it has the tag.
  A task untagged before the destination starts is handed back to the
  stage it waited in (`intake` or `prepared`) with nothing run, and is
  never dispatched while untagged. If the same change also dropped the
  state, the run cannot hand it back, so it leaves a note instead: once the
  state is restored, the attempt reads `failed`, "nothing ran", and only an
  explicit `retry` or `reroute` goes on. Tags change only through `task.update`
  (or at creation), which always moves the task's `updatedAt` token (the
  store keeps it strictly increasing), so a removal between a write's read
  and its commit always conflicts and is seen. Work whose destination
  already started is not cancelled by removing the tag: it finishes, and
  its result is recorded as usual, by a note if the same change dropped the
  state. You can `accept` it or `abandon` a parked attempt without tagging
  the task again. Untagging never erases the state: a dropped state is put
  back, and tagging the task again goes on from the stage it is in, with
  its history; it is not refined or run again. Cancel a run to stop it.
- **Crashes.** An attempt that is in flight and not parked, under an owner
  whose process stopped (a crash, a graceful stop that cancelled its run, or
  a resumed parked run that then crashed), cannot come back: the engine
  never loads a run that was mid-flight. The next process's observer marks
  it `interrupted` on its first delivery, or when you launch
  `task-pipeline-reconcile`. If nothing changes after a restart, nothing is
  delivered and nothing reconciles until you launch the step. Interrupted
  work is never restarted automatically; `retry` is explicit.
- **Getting out of a parked attempt.** If a parked run can never resume (you
  cancelled it after a restart, or no host that can answer questions is
  running), request `abandon`. A parked run cancelled in the host that
  launched it is recorded `failed` without one.
- **Side effects are not exactly once.** The pipeline prevents duplicate
  dispatch and replay: one claim, one run per attempt, no retry beside a
  parked run, no relaunch from redelivery. It cannot undo work: a
  destination that crashed may have done part of it, and `retry` runs it
  again.
- **Graceful stop.** When the host stops, a running run is cancelled, but
  the stopping host no longer accepts task writes. The attempt stays in
  flight, as after a crash, and the next host marks it `interrupted`. A
  parked run is kept, as above.

Known gaps:

- A host crash in the moment after the pipeline marks an attempt `parked`
  and before the engine saves the run as suspended leaves a parked attempt
  no run will resume. Request `abandon`.
- A park noted while the state was missing is applied only by the restore
  that follows. If a second metadata replacement drops that note before the
  restore reads it, the attempt is restored unmarked, and after a restart
  it reads as interrupted; resuming then does nothing. Request `abandon`
  for a parked attempt you know will not come back. (An ending is not lost
  this way: the observer also applies an ending from the images of the
  change that dropped it.)
- Reconcile reads only tagged tasks. An untagged task whose attempt was in
  flight (not parked) when its process stopped stays in flight until it is
  tagged again; then reconcile marks it `interrupted` as usual.
- A change the observer keeps failing on holds back its later changes,
  for every task, until it completes it. That is the cost of ordered
  delivery; the failing write is printed with the change's id each time
  it is tried.
- Records from before pending restores can hold a drop already delivered
  with nothing owed on the task, and so can records edited by hand. No
  later change restores or enrolls such a task. Its last state is the
  `before` of the latest change in `<state>/tasks.json` that dropped it:
  put it back under `metadata.pipeline`, or request `refine` to start it
  over without its history.
- A pause is told from a cancel by the run's signal. A step timeout also
  aborts only the step's signal; the pipeline's own steps set none, but one
  configured on them would be marked `parked` before the run fails, and the
  failure is then recorded in the same host as usual.
- Each observer pass reads every tagged task: cost grows with the number of
  pipeline tasks, not with the change.

## Verify

```sh
cd apps/marbles
bunx vitest run test/task-pipeline.test.ts test/task-pipeline-restart.test.ts test/task-pipeline-stdio.test.ts
bun run typecheck
```

The tests use model doubles. `task-pipeline-stdio.test.ts` drives a real
STDIO MCP server under `--dry-run`: create over `change_tasks`, refinement,
`prepare`, `blocked` without a model, a user `reroute` that runs, `accept`,
and a `requireReady` start refused with `not_ready`.
`task-pipeline-restart.test.ts` runs real host processes over one state
dir: a crash inside the destination; a run parked on a question across a
graceful stop, answered in the next process and finished by the same run;
a resumed parked run that crashes; a refinement paused mid-turn across
a graceful stop, resumed in the next process by the same run; and a host
killed just before restoring a failed run's dropped state, followed by an
edited observer that is handed the whole history and restores that failed
state, not an older one, running nothing again; and a host killed after it
recorded a drop it was behind on (the task was renamed first), whose same
observer restores the failed run in the next process, after which
untagging and tagging the task again runs nothing; and a host killed
while the observer's writes for the change that gave the task its failed
state back, and for that state's drop, keep failing, after which the same
observer and, over a copy, an edited one each restore that failed run, not
the older retry state the task held before, and nothing runs again. None
of them call a provider.
Routing quality on a real model is not measured.
