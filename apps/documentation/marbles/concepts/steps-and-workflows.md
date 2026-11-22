---
title: Steps and workflows
description: Declare typed work, connect results into a tree, nest workflows, and choose between running, enqueuing, and locking.
---

A step owns one piece of work. A workflow gives a tree of steps a name and
launch input. A parent receives its children's results, so children run
first. Marbles builds this tree on
[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md),
which records each step's result.

## Declare a step

A builder describes the work, then ends with `.do(body)` or `.exec(command)`:

```ts
step("name")
  .describe("Shown in the catalog and the launch form.")
  .input(schema)
  .output(schema)
  .config({ retry, timeout })
  .do(async (context) => result);
```

`.input(schema)` validates launch input and types the body. Any Standard
Schema library works; these docs use `zod`. `.output(schema)` validates the
result. Results must be plain JSON, so return an ISO string rather than a
`Date`. `.config` sets a per-attempt `timeout` and a `retry` policy;
[durability](/marbles/concepts/durability#retry-a-failed-attempt) covers
both.

## One-command steps

A step whose work is one command can skip the body:

```ts
const tests = step("tests").exec("bun test", { check: false });
const add = step("add-package")
  .input(z.object({ package: z.string() }))
  .exec("bun add $package");
```

The template is split into arguments when the module loads and is never
read by a shell. `$package` fills one argument from the input, so a value
with spaces stays one argument. The result is `{ exitCode, stdout, stderr }`,
and a nonzero exit fails the step unless `check: false`.

The options can come from the context instead, computed for each run:

```ts
step("test-in")
  .input(z.object({ dir: z.string() }))
  .exec("bun test", ({ input }) => ({ check: false, cwd: input.dir }));
```

The function may be async. Computed options need the current source
checkout.

## Hand a result to the next step

A parent declares the child results it consumes in its input schema. Save
this module as `.foundry/marbles/summary.ts`, with `zod@4.4.3` installed:

```ts
import { step, workflow } from "@foundry.sh/marbles";
import { z } from "zod";

const count = step("count-matching")
  .input(z.object({ extension: z.string() }))
  .output(z.number())
  .do(async ({ input, workspaces }) => {
    const files = await workspaces.current.files();
    return files.filter((file) => file.path.endsWith(input.extension)).length;
  });

const summarize = step("summarize-count")
  .input(z.object({ count: z.number(), extension: z.string() }))
  .output(z.string())
  .do(({ input }) => `${input.count} files end in ${input.extension}`);

workflow("file-summary")
  .input(z.object({ extension: z.string() }))
  .do(({ input }) =>
    summarize({ count: count({}, { extension: input.extension }) }, input)
  );
```

Run `marbles run file-summary --input '{"extension":".ts"}'`.

`summarize(children, literalInput)` takes children first and literal input
second. `count` supplies `input.count`, and the literal supplies
`input.extension`. A key cannot appear in both, and a child key the
parent's schema does not declare fails at load.

## Run independent work together

```ts
const lint = step("lint").exec("bun run lint", { check: false });
const tests = step("tests").exec("bun test", { check: false });
const exit = z.object({ exitCode: z.number() });

const verdict = step("verdict")
  .input(z.object({ lint: exit, tests: exit }))
  .do(({ input }) => input.lint.exitCode === 0 && input.tests.exitCode === 0);

workflow("checks", () => verdict.parallel({ lint: lint(), tests: tests() }));
```

`verdict(...)` and `verdict.series(...)` run children in key order.
`.parallel(...)` runs them together. If one parallel child fails, Marbles
aborts the siblings and waits for them before reporting the failure. A
sibling that parks on a question parks the parent while the others finish.

Data flows from children to their parent, never between siblings. Locking
the same definition under two siblings runs it twice. When two siblings
both need one result, give that result to a nested workflow, which hands
it to each of its nodes as literal input.

## Nest a workflow

A workflow locks inside another tree the way a step does. Save this module
as `.foundry/marbles/changed-checks.ts`:

<include>./_example/changed-checks.ts</include>

In a repository with at least two commits, run `marbles run
check-changed`. The inner workflow still runs on its own with
`marbles run checks-in --input '{"dir":"."}'`.

`checks({ dir: changedPackage() })` locks `checks-in` with one child. A
nested workflow runs like this:

1. **TypeScript checks the lock.** A child whose output does not fit the
   key it fills, here a string for `dir`, is a type error where you lock it.
2. **Children run first.** Their results and the literal input are
   validated against the workflow's input schema when the node runs.
3. **Setup runs next.** Marbles calls the nested workflow's setup with that
   input and runs the tree it returns under the node, as `$workflow`. Here
   the verdict's path is `check-changed.$workflow` and its children sit
   under it, such as `check-changed.$workflow.lint`.

The nested steps belong to the outer run. The dashboard shows them under
`$workflow`. Approvals, pause and resume, adoption after a restart, and
cancellation reach them as they reach any step, and a `.parallel` sibling
that fails aborts them. Pause and resume a nested tree at the node that
locks it. A nested workflow has no `retry` of its own. When a parent with a `retry` policy is retried, a failed nested
workflow under it runs its failed steps again in place, as a failed step
child would.

A workflow locked inside itself, directly or through others, fails its node
when the run reaches it. The error names the chain, such as
`"ping" → "pong" → "ping"`. For bounded recursion, call the workflow with
`.run()` from a step.

The [Software Factory](/marbles/use-cases/software-factory/verify) nests its
verification workflow under the build that produces the commit.

## Choose what belongs in a step

Make an operation a child step when its result, failure, or progress should
be visible on its own. Keep ordinary calculations inside a body. Make a
group of steps a workflow when you want to run it on its own and also lock
it inside larger trees.

There are no race, branch, or loop combinators. Choose a tree in ordinary
TypeScript during workflow setup, and keep commands, file access, and agent
turns inside steps.

## Run, enqueue, or lock

| Form | Separate run? | Waits? | Use it for |
| --- | --- | --- | --- |
| Lock as a child: `review()` | No, a node in this run | The parent waits | Work whose result the parent needs, visible in the run tree |
| `await review.run(input?)` | No, nested in the caller | Yes | A quick helper call inside a body |
| `await review.enqueue(input?, { key? })` | Yes, a top-level run | No | Handing off work from an observer or a step |
| `await workflow.enqueue("review", input?, { key? })` | Yes, a top-level run | No | The same handoff by name, without importing the definition |

Locking a workflow and enqueuing one differ in what you get. A nested
workflow is part of one run. Its steps share the run's id, its replay, and
its cancellation, and its result flows into the parent. An enqueued
workflow is a separate top-level run on the queue, with its own id and
status. It succeeds or fails on its own, and the enqueuing code carries on
without it. Nest a workflow when the parent needs its result. Enqueue one
when the work should outlive the code that started it, as an approval that
waits for days does.

`.run()` executes in this process, outside the engine's queue. Its nested
execution does not appear as its own dashboard run and cannot be paused on
its own.

`.enqueue()` admits a run on the engine and resolves with `{ id, result }`
before the run ends. Keep `id` to read the run later with `runs.get(id)`,
or await `result` for its output. An unawaited `result` never raises an
unhandled rejection. Input that fails the schema rejects the `enqueue`
call when the queue has room to start the run; a run that waits in the
queue reports the failure through `result` instead.

### Enqueue once per key

`enqueue(input, { key })` starts at most one run per key:

```ts
const { id } = await build.enqueue({ task: task.id }, { key: `build:${task.id}` });
```

Marbles matches the key together with the definition's name, across every
engine that shares the workspace's store. A second enqueue with the same
name and key returns the first run's handle, with a real `result`, whatever
that run's state: queued, running, parked on a question, complete, failed,
or cancelled. The second call's input is ignored. `result` resolves with
the first run's output, or rejects with its failure. The match holds for as
long as the run's record is kept. The CLI keeps them, and an embedding host
can remove settled ones with `engine.executions.prune`. Enqueuing by name
and `marbles enqueue <name> --key <key>` match the same keys.

Choose the key from what should happen once:

- **Once per task.** `key: task.id`, or `` key: `build:${task.id}` `` when
  several definitions serve one task.
- **Once per attempt.** When a task can come back after a failure or a
  revision, put a counter in the key that advances each time it comes back:
  `` key: `build:${task.id}:attempt-${attempt}` ``. Reusing a key after its
  run failed hands back that failure instead of starting a new run.

A blank key is refused with `enqueue(): a key must be a non-blank string`.
A key also needs a definition the workspace's source declares by name. An
anonymous definition is refused, and so is any enqueue with a key from a
plain `bun` script, whose engine declares no definitions.

An observer is delivered each change at least once, so a handler that
enqueues should pass a key. A redelivered change then finds the run the
first delivery started. [The outer loop](/marbles/get-started/outer-loop#write-the-loop)
dispatches tasks this way.

### Enqueue by name

`step.enqueue(name, input?, options?)` and
`workflow.enqueue(name, input?, options?)` enqueue a step or workflow the
workspace declares, looked up by its name when the call runs. One module
can hand work to another file's definition without importing it. Save the
build as `.foundry/marbles/package-build.ts`:

<include>./_example/package-build.ts</include>

and the release, which never imports it, as `.foundry/marbles/release.ts`:

<include>./_example/release.ts</include>

`marbles run release --input '{"ref":"main"}'` runs the release, which
resolves `main` to a commit, enqueues `package-build` as a run of its own,
and waits for its result. The key names the commit, so releasing the same
commit again gets that build back, and a new commit on `main` builds anew.

The lookup finds the definition the engine registered under that name and
enqueues it as its own `.enqueue()` would:

- **One key space.** `step.enqueue("package-build", input, { key })`,
  `.enqueue(input, { key })` on the definition where it is imported, and
  `marbles enqueue package-build --key <key>` share one key per definition
  name. Whichever comes first starts the run; the others get it back.
- **Each word takes its own kind.** `workflow.enqueue("package-build")` is
  refused with `workflow.enqueue("package-build"): "package-build" is a
  step, not a workflow; use step.enqueue("package-build")`, and
  `step.enqueue` refuses a workflow the same way. A name the workspace does
  not declare, a monitor's key among them, is refused with `this workspace
  declares no step or workflow named "<name>"`. A blank name throws a
  `TypeError`. From a step body, a refusal fails the step.
- **Input is not typed.** The call takes `Record<string, unknown>` and the
  definition's schema checks it when the run starts. Name the output type
  with a type argument, as in `step.enqueue<{ ok: boolean }>("package-build")`;
  `result` is `unknown` without one.
- **Replay and the queue work as for `.enqueue()`.** A step body that runs
  again gets the same run back, and awaiting `result` gives up the queue
  slot. See [Enqueue from a step](#enqueue-from-a-step).
- **The word belongs to its workspace.** When one Marbles process hosts
  several workspaces, the `step` and `workflow` a workspace's source
  imports enqueue into that workspace, whichever run calls them. During
  the source's own load they refuse: `the workspace's runs are not
  available while its source loads; enqueue them in a step, an observe
  handler, or once the host has started`. Once that workspace's host is
  disposed, they refuse with `nothing was enqueued`.
- **In a plain `bun` script** no workspace hosts, the name is found among
  the script's own declarations: at top level, in its step bodies, and in
  its monitor handlers. A key is refused there, as it is for `.enqueue()`.

### Enqueue from a step

Inside a step body, `.enqueue()` starts a top-level run on the same engine
and records it in the step's ledger. A body that runs again after a
question or a resume gets the same run back for the same definition at the
same place, so a replayed handoff is not enqueued twice. A replayed body
that reaches a different definition at that place enqueues it. The ledger
covers replay, not a retried attempt. Give the enqueue a key when a step
with `retry` must enqueue once, and the retried attempt gets the first run
back.

A step can await what it enqueued:

```ts
step("release").do(async () => {
  const { result } = await build.enqueue({ ref: "main" });
  return await result;
});
```

Reading `result` gives up the enqueuing run's queue slot until the
enqueued run settles, then takes it back. Awaiting an enqueued run
therefore never deadlocks the queue, even at `queue({ concurrency: 1 })`.
A step that keeps only `id` keeps its run's slot, so on a full queue the
enqueued run waits until the enqueuing run ends. [How many runs at once](/marbles/concepts/durability#how-many-runs-at-once)
covers the queue.

`.enqueue()`, `step.enqueue(name)`, `workflow.enqueue(name)`, and `key`
need the current source checkout.

## Contexts

A context is the object Marbles passes to a callback.

### Workflow setup

`workflow(...).do(setup)` receives `{ input, log, run: { id } }` and returns
the tree. It has no `agents`, `exec`, `ask`, or resource managers. Setup
can run again when Marbles rebuilds a parked run, so keep it free of work
that should happen once.

### Step execution

`step(...).do(body)` receives `Context<I>`. Its `input` combines literal
input with the completed child results its schema declares.

```ts
step("inspect-runtime").do(({ workspaces, run, log }) => {
  log("Working in", workspaces.current.root);
  return { runId: run.id, workspace: workspaces.current.root };
});
```

| Group | Properties | What the step can do |
| --- | --- | --- |
| Data | `input` | Read validated input and child results. |
| Resources | `workspaces`, `agents`, `sandboxes`, `artifacts` | Work with directories, conversations, environments, and outputs. |
| Commands | `exec` | Run an argument list with streamed output and cancellation. |
| People and results | `ask`, `report` | Wait for a person's answer or publish an outcome. |
| Execution | `log`, `stream`, `signal`, `run` | Write output, observe cancellation, and identify the run. |

`tasks` and `runs` are module imports rather than context properties.
Inside a step they read and write the hosting workspace.

### Binding resources to a run

Calling a resource inside a step binds that operation to the run: its
working directory, output stream, cancellation signal, and lifetime. A
session from `agents.session(reviewer)` writes to the step's stream and
stops when the step is cancelled or paused. `workspaces.load` returns a
`LoadedWorkspace`, `sandboxes.start` a `SandboxHandle`, and an artifact
write an `ArtifactVersion`.

Ordinary TypeScript needs its own wiring. Pass the context's `signal` to a
raw `fetch` if it should stop with the step. A client you construct
yourself does not gain Marbles' bindings.

### Other callbacks

A monitor handler receives the step context plus `change` and file or HTTP
data; see [Monitoring and scheduling](/marbles/concepts/monitoring-and-scheduling).
An observer handler receives one fact and no context; it runs outside any
run, so a definition it enqueues starts a run of its own. See [Tasks and
observability](/marbles/concepts/tasks-and-observability#observe-what-changed).

The [builder reference](/marbles/reference/api#the-builder) and
[context reference](/marbles/reference/api#context) list every option.
Next: [Agents, skills, MCP, and sessions](/marbles/concepts/agents-and-sessions).
