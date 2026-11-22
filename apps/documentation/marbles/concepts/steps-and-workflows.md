---
title: Steps and workflows
description: Declare typed work, connect results into a tree, and choose between running, launching, and locking.
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

Run `marbles roll file-summary --input '{"extension":".ts"}'`.

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
the same definition under two siblings runs it twice. When two stages both
need one result, launch the second stage with that result as input; the
[Software Factory](/marbles/use-cases/software-factory/verify) does this
with a built commit.

## Choose what belongs in a step

Make an operation a child step when its result, failure, or progress should
be visible on its own. Keep ordinary calculations inside a body. A
workflow can be the root of a run, but not a child in another tree; reuse
its steps instead.

There are no race, branch, or loop combinators. Choose a tree in ordinary
TypeScript during workflow setup, and keep commands, file access, and agent
turns inside steps.

## Run, launch, or lock

| Form | Separate run? | Waits? | Use it for |
| --- | --- | --- | --- |
| Lock as a child: `review()` | No, a node in this run | The parent waits | Work whose result the parent needs, visible in the run tree |
| `await review.run(input?)` | No, nested in the caller | Yes | A quick helper call inside a body |
| `await review.launch(input?)` | Yes, a top-level run | No | Handing off work from an observer or a step |

`.run()` executes in this process, outside the engine's queue. Its nested
execution does not appear as its own dashboard run and cannot be paused on
its own.

`.launch()` admits a run on the engine and resolves with `{ id, result }`
before the run ends. Keep `id` to read the run later with `runs.get(id)`,
or await `result` for its output. An unawaited `result` never raises an
unhandled rejection. Input that fails the schema rejects the launch when
the queue has room to start it; a launch that waits in the queue reports
the failure through `result` instead.

Inside a step body, `.launch()` starts a top-level run on the same engine
and records it in the step's ledger. A body that runs again after a
question or a resume gets the same run back for the same definition at the
same place, so a replayed handoff does not launch twice. A replayed body
that reaches a different definition at that place launches it. That
guarantee covers replay after a question or a resume, not a retried
attempt, so keep `retry` off steps whose launches must happen once.

`.launch()` needs the current source checkout.

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
run, so a definition it launches starts a run of its own. See [Tasks and
observability](/marbles/concepts/tasks-and-observability#observe-what-changed).

The [builder reference](/marbles/reference/api#the-builder) and
[context reference](/marbles/reference/api#context) list every option.
Next: [Agents, skills, MCP, and sessions](/marbles/concepts/agents-and-sessions).
