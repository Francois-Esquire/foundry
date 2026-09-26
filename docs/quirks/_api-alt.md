# Quirks API

Maintainer note, excluded from the Blume site. The public API for
`quirks.config.ts`. The library is being rebuilt to match it; where the code
differs from this document, this document wins.

This is the outermost API: what an author writes. How the library implements
it is free to change.

## Principles

1. **Composition and definition.** A definition sets defaults. Wherever it is
   used adds context. The most recent layer wins, and anything inherited can be
   overridden.
2. **Schemas describe inputs and outputs.** One schema gives the TypeScript
   type, the dashboard's launch form, validation at launch, and a contract the
   catalog, the companion skill, and agents can read. Any
   [Standard Schema](https://standardschema.dev) library works (zod, valibot,
   arktype). Validation and types need only Standard Schema. The launch form
   and the catalog contract need the library's Standard JSON Schema interface
   as well; without it, a named definition's launch form is one JSON field.
   Schemas are optional.
3. **Names are the catalog.** A named step or workflow can be launched by name
   from the CLI, the dashboard, and anything else that invokes it dynamically.
   An anonymous one is internal.
4. **No string references in code.** Definitions refer to each other as
   values. Names exist only for invoking from outside the config.
5. **Everything through the context.** Each package's API is created for the
   run and handed to every `.do` under a plural context key. It passes
   through, decorated for Quirks.
6. **The packages supply mechanics, not the API.** `@foundry/workflows`,
   `@foundry/agents`, `@foundry/workspaces`, `@foundry/sandbox`, and
   `@foundry/artifacts` do the work. Where their APIs differ from this one,
   this one wins and the package is adapted under it.
7. **Wired by default.** Cancellation, streaming, the working directory, and
   the run's session reach every agent, sandbox, and workspace a step opens
   without the author connecting them. Authored code never builds plumbing.
   See [Wired by default](#wired-by-default). Non-negotiable.

## A complete config

Nothing is exported. Calling a top-level word registers it with the config.

Everything assigned to a `const` below is authored by the config. The API is
the imports and the context keys. Nothing here creates worktrees, sandboxes,
or sessions on its own: a step asks the context for one. How work is handed
between steps (a branch, an artifact, a path) is the author's design; the
companion skill teaches the common patterns.

```ts
import {
  agent, artifact, monitor, sandbox, schedule, skills, step, workflow, workspace,
} from "@foundry/quirks";
import { z } from "zod";

// Definitions
const reviewing = skills.load().add("./skills/review/*");
const reviewer = agent({ prompt: "Review without editing.", skills: reviewing });
const implementer = agent({ prompt: "Implement the task. Keep changes small." });
const site = workspace({ path: "../marketing-site" });
const box = sandbox({ image: "docker.io/oven/bun:1-slim", mount: "." });
const weeklyReport = artifact({ name: "Weekly report", type: "text/markdown" });

// Steps
const review = step("review")
  .input(z.object({ target: z.string().default("."), branch: z.string().optional() }))
  .output(z.string())
  .do(async ({ input: { target, branch }, agents, log }) => {
    log("reviewing", branch ?? target);
    const session = await agents.session(reviewer);
    const subject = branch ? `branch ${branch} against main` : target;
    return (await session.generate(`Review ${subject}.`)).text;
  });

const test = step().do(async ({ sandboxes, stream }) => {
  const env = await sandboxes.start(box);
  const result = await env.exec(["bun", "test"]);
  stream.write(result.stdout);
  return result.exitCode;
});

// Works in a temporary worktree and hands the branch on. The worktree comes
// from the workspaces API and lives only inside this call.
const implement = step()
  .input(z.object({ task: z.string() }))
  .output(z.string())
  .do(({ input: { task }, agents, workspaces, run }) =>
    workspaces.current.git.withWorktree(
      { base: "main", branch: `task/${run.id}` },
      async (checkout) => {
        const session = await agents.session(implementer, { cwd: checkout.root });
        await session.generate(`${task}\n\nCommit when done.`);
        return checkout.branch;
      }
    )
  );

const publish = step()
  .input(z.object({ findings: z.string(), exitCode: z.number() }))
  .do(async ({ input: { findings, exitCode }, report }) => {
    const version = await report.artifact(weeklyReport, {
      "report.md": `${findings}\n\nTests: ${exitCode}`,
    });
    return version.id;
  });

// Asks first, so nothing before the ask repeats on resume.
const approve = step()
  .input(z.object({ review: z.string() }))
  .do(async ({ input: { review }, ask }) => {
    const { approved } = await ask.approval({ title: "Merge it?", body: review });
    return approved;
  });

// Workflows
const weekly = workflow(
  "weekly",
  publish.parallel({
    findings: review({}, { target: site.path }),
    exitCode: test({}),
  })
);

// Each step consumes the one below it: implement → review → approve.
const ship = workflow("ship")
  .input(z.object({ task: z.string() }))
  .do(({ input: { task } }) =>
    approve({
      review: review({ branch: implement({}, { task }) }),
    })
  );

// Triggers
schedule(weekly).at({ weekday: "fri", hour: 16 });
schedule(review({}, { target: "packages" })).every("6h");

monitor("docs/**/*.md").do(({ files, log }) => log(files));

monitor("https://status.example.com/api")
  .every("5m")
  .do(async ({ response, report }) => {
    const { status } = await response.json();
    report.milestone({ title: `Status: ${status}` });
  });

monitor("https://tracker.example.com/issues/latest")
  .every("10m")
  .do(async ({ response }) => ship({}, { task: (await response.json()).title }));
```

Nameless steps such as `test` and `implement` take the name of the `const`
they are assigned to, read from the config's source with the project's own
`typescript` (an optional peer). A definition made inside a function or
inline stays internal.

## Top-level words

| Word | Kind | Shape | Purpose |
| --- | --- | --- | --- |
| `agent` | definition | `agent({ prompt, model?, provider?, skills? })` | Who does model work, with its default context. `skills` takes a skill set. |
| `workspace` | definition | `workspace({ path })` | Another directory to work on. The config's own is implicit. |
| `sandbox` | definition | `sandbox({ image, mount?, resources? })` or `sandbox({ files, image? })` | An isolated place to run commands; the files form is a scratch sandbox seeded under `/workspace`. |
| `artifact` | definition | `artifact({ name, type })` | A versioned output. |
| `skills` | definition | `skills.load().add(glob).pick(...names)` | A set of skills for a session. |
| `step` | work | `step(name?).input(s).output(s).do(fn)` | One unit of work. |
| `workflow` | work | `workflow(name?, tree)` or `workflow(name?).input(s).do(fn)` | Setup plus a tree of steps. |
| `schedule` | trigger | `schedule(definition).at(slot)` or `.every(interval)` | Runs a step or workflow on a clock. |
| `monitor` | trigger | `monitor(source).every?(interval).do(fn)` | Runs when files or an HTTP response change. |

Definitions are presets. They are optional: the context can also create the
same thing on the spot (see [Context](#context)).

- **A declared artifact keeps its identity across runs.** Each run adds a
  version to the same artifact.
- **A declared workspace is a directory preset.** It has no state, reports,
  or dashboard entry of its own.
- **A sandbox mounts workspaces read/write.** The config's own directory and
  any declared workspace it uses mount read/write. Host configuration folders
  (`~/.foundry`, `~/.claude`, `~/.codex`) mount read-only. Nothing else is
  mounted.
- **Skills are a set, built by chaining.** `skills.load()` with no arguments
  loads the global and workspace skills. `.add(glob)` appends a folder of
  skills. `.pick(...names)` narrows a set to the named skills. Calls chain,
  and each returns a new set. The result is what an agent's `skills` field
  takes, through the skills tool.

  ```ts
  const skillset = skills.load();
  const baseSkills = skillset.pick("caveman", "unslop");
  const review = skillset.add("./skills/review/*");
  const reviewer = agent({ prompt: "Review without editing.", skills: review });
  ```

## Context

The one object every step and workflow `.do` receives. Destructure what you
need:

```ts
step().do(async ({ input, agents, workspaces, sandboxes, artifacts, ask, report, log, stream, signal, run }) => …);
```

A monitor's `.do` gets the same object, with `files` or `response` in place of
`input`.

| Key | What it is |
| --- | --- |
| `input` | The typed input, validated against `.input(schema)`. |
| `agents` | Agent sessions. |
| `workspaces` | Directories: the config's own and any other. |
| `sandboxes` | Isolated places to run commands. |
| `artifacts` | Versioned outputs. |
| `ask` | Stop and ask a person: `ask.question(…)`, `ask.approval(…)`. |
| `report` | Tell people what happened: `report.milestone(…)`, `report.result(…)`, `report.artifact(…)`. |
| `log` | Run logs. |
| `stream` | The step's live output. |
| `signal` | Cancellation. Always present. |
| `run` | The run scope: `{ id, session, signal, stream, path, abort() }`. The top layer; see [Layers of cancellation](#layers-of-cancellation). |

### Context keys backed by packages

Four keys are a package's API, created for the run and passed through with
Quirks decorations.

| Key | Package API |
| --- | --- |
| `workspaces` | `WorkspaceSystem` (`@foundry/workspaces`, with `directory()` and `git()`) |
| `sandboxes` | The containers registry (`createContainers` in `@foundry/sandbox`) |
| `artifacts` | `ArtifactSystem` (`@foundry/artifacts`) |
| `agents` | Sessions (`createAgentPreset(spec).createSession()` returns a `SessionHarness`; a `SessionStore` persists them; no single class yet) |

What Quirks adds to each of these keys:

- **Scoped to the run.** What a run starts or opens is attributed to it and
  closed when the run settles.
- **Composed defaults.** The working directory and the model come from the
  scope (see [Composition](#composition)), overridable per call. Sessions are
  not inherited; see [Sessions](#sessions).
- **Definitions accepted.** Anywhere one of these keys takes a spec or an id, it also
  takes the matching top-level definition.
- **Stored in the config's residency.** State lives in the config's folder under
  `~/.foundry`, not in memory.

Top-level definitions are optional presets. The context creates the same
things on the spot, as often as a run needs.

**Naming rule.** Singular words are imports (`agent`, `workspace`, `sandbox`,
`artifact`). Plural keys are the context (`agents`, `workspaces`, `sandboxes`,
`artifacts`). Nothing in the context shadows an import.

### agents

```ts
const session = await agents.session(reviewer);                   // a definition
const scoped = await agents.session(reviewer, { cwd: checkout.root }); // with an override
const again = await agents.session(reviewer, { session });         // continue a session
const reply = await session.generate("Review the change.");
```

### workspaces

```ts
const here = workspaces.current;                          // the config's own
const files = await here.files();
await here.git.withWorktree({ base: "main" }, async (checkout) => { … });

const siteWs = await workspaces.load(site);               // a definition
const docs = await workspaces.load({ path: "../docs-site" }); // on the spot
```

### sandboxes

```ts
const env = await sandboxes.start(box);                                      // a definition
const scratch = await sandboxes.start({ image: "docker.io/oven/bun:1-slim" }); // on the spot
const result = await env.exec(["bun", "test"]);
```

### artifacts

```ts
const version = await artifacts.write(weeklyReport, { "report.md": markdown }); // a definition: a new version. report.artifact does this and posts it
const page = await artifacts.create({ name: "Prototype", type: "text/html", entries }); // on the spot
```

### ask

```ts
const { approved, note } = await ask.approval({ title: "Merge it?", body: review });
const answer = await ask.question({ title: "Which region?", choices: ["us", "eu"] });
const free = await ask.question({ title: "Anything to add?" });          // free text
```

Both suspend the step until a person answers, and both are attributed to
the run so a host can show what it is waiting on. They differ in weight:

- **`approval` is a hard block.** The run shows as blocked. The answer is
  `{ approved, note? }`. What a refusal means is the author's: return it,
  branch on it, or throw.
- **`question` is input.** The step waits, the run shows as waiting, and
  siblings keep going. `choices` gives a pick list; without it the answer is
  free text.

Each call is identified by its position in the body (see
[Writing replayable steps](#writing-replayable-steps)), so there is no key.
An explicit `key` is optional, for updating the same entry across steps.

### report

```ts
report.milestone({ title: "Tests green" });
report.result({ title: "Summary", body: markdown });
const version = await report.artifact(weeklyReport, { "report.md": markdown });
```

Reports are fire-and-forget and each becomes an entry on the run. A host
renders them: an icon when a milestone lands, a status line when a step
continues, a card for a result. They also serve as signals for anyone
watching the run.

- **`milestone`** marks progress. Title, optional body.
- **`result`** carries an outcome in markdown, with optional media.
- **`artifact`** takes an artifact definition and files, writes a new version
  to that artifact, posts it, and returns the version. Authors never touch
  versions directly; the artifact abstraction lives behind this call.

### log, stream

```ts

log("reviewing", target);
log.warn("slow response", ms);

stream.write("Tag ready\n");
await stream.pipe(session.stream(prompt));
```

### signal, run

```ts
await fetch(url, { signal });                                   // cancelled with the step
const lead = await agents.session(delegator, { session: run.session }); // the run's session
log("run", run.id, "at", run.path);
run.abort(new Error("unrecoverable"));                          // shut the whole run down
```

`run` is the run scope itself, exposed for advanced patterns. Everyday code
uses the step-scoped keys and never reads it.

Removed from what authors see: `models`, `executors`, `sessions`, `state`, and
the old `workspace` / `workspaces` pair. They remain internal.

Pending changes to `sandboxes` are listed under [Open](#open).

## Steps and workflows

### The builder

```ts
step(name?)          // a builder
  .describe(text)    // optional: shown in the catalog and launch form
  .input(schema)     // optional
  .output(schema)    // optional
  .do(fn)            // returns the definition
```

- **Name.** A string first argument makes the step launchable by that name.
  Without one the step is anonymous and used by reference. A repeated name is
  an error when the config loads.
- **Schemas before the body.** `.input()` and `.output()` come before `.do()`
  so `do` is typed from them. Nothing is written twice.
- **No input schema, no launch input.** The launch form is empty and the step
  runs without input.
- **A parent declares its input too.** A step that receives children's results
  declares them in `.input()` like any other input, so its body is typed. At
  lock time each child's output is checked against the parent's input key.
- **One argument.** `do` receives a single object to destructure. The input is
  one of its keys: `({ input, agents, log, … })`.
- **`do`, not `run` or `then`.** `run` and `execute` read as "execute now".
  `then` makes the builder a thenable, so `await` or an `async` return would
  call it.

`workflow` uses the same builder, and accepts two short forms:

```ts
workflow(name?, tree)                          // a tree, no input
workflow(name?, () => tree)                    // a function returning the tree
workflow(name?).input(schema).do(fn)           // typed input: fn returns the tree
```

A function passed directly (`workflow(({ input }) => …)`) would be typed before
any schema, so typed input always goes through `.input().do()`.

### Build, then lock

A definition has two phases:

1. **Build.** `step()` returns a builder. `.input()`, `.output()`, and `.do()`
   shape the definition. Nothing is in a graph yet.
2. **Lock.** Invoking the definition is the terminal call. Calling it as a
   function (`publish(children, input?)`) or through a combinator
   (`publish.series(children, input?)`, `publish.parallel(children, input?)`)
   locks in one node: this definition, these children, this input.

The two arguments are always in that order:

- **Children first.** An object of locked nodes keyed by name. A leaf passes
  `{}`.
- **Input second, optional.** Literal values for the step's input.

The children's results and the literal input merge into one object, which is
what the body receives as `input`. A key present in both is an error when the
config loads.

```ts
review({}, { target: "." });                 // a leaf: no children, literal input
publish({ findings: review({}) }, { exitCode: 0 }); // one child, one literal
```

One definition can be locked many times. Each lock is its own node, and a
workflow's graph is made of these nodes.

### Trees

A workflow wires locked nodes together by reference.

```ts
publish.parallel({
  findings: review({}, { target: site.path }),
  exitCode: test({}),
});
```

```
publish
├─ findings   (review)
└─ exitCode   (test)
```

- **Children.** Nodes passed into a step become its child steps.
- **Keys name them.** `findings` and `exitCode` are the children's names in the
  dashboard, on resume, and in the parent's input.
- **The parent runs last.** It receives `{ findings, exitCode }` once its
  children finish.
- **Siblings are independent.** Data flows only from children to their
  parent. A step that needs another's result takes it as a child, as `review`
  takes `implement` in `ship`.
- **Combinators live on every definition.** A workflow is a step, so both carry
  the same methods:

| Call | Children run |
| --- | --- |
| `publish(children, input?)` | In key order. |
| `publish.series(children, input?)` | In key order (explicit form). |
| `publish.parallel(children, input?)` | Together. |

`.parallel` is the only combinator for now. Race, branch, and loops come
later.

### Workflow setup is not durable

A workflow's `.do` is setup: it prepares things and returns the tree. The two
have different durability:

- **Steps are durable once finished.** A finished step returns its recorded
  result instead of running again.
- **A suspended step is not finished.** After an `ask` resolves, the body
  replays from the top with the answer in hand. Any effect before the ask runs
  again. Put the ask first, or in a step of its own, as `approve` does.
- **Setup is not durable.** It runs every time the workflow is set up,
  including on resume, and builds the tree again.

Setup becomes durable only by passing it into a step as input. A step's input
is recorded with that step. Anything else setup creates (a started sandbox, an
open session) is created again on the next setup.

This differs from `@foundry/workflows`, where a workflow's body is itself a
durable step. It is deliberate: setup stays a place to prepare, not work to be
recorded.

## Triggers

### schedule

```ts
schedule(weekly).at({ weekday: "fri", hour: 16 });
schedule(review({}, { target: "packages" })).every("6h");
```

- Takes a step or workflow, bare or locked. A locked node carries its input,
  so there is no `input` field.
- `.at(slot)` or `.every(interval)` is the terminal call.

### monitor

```ts
monitor("docs/**/*.md").do(({ files }) => …);
monitor("https://status.example.com/api").every("5m").do(({ response }) => …);
```

- Takes one string. `http://` or `https://` means an HTTP poll. Anything else
  is a file glob.
- `.do(fn)` is the terminal call. `fn` gets the [context](#context), plus
  `files` for a glob or `response` (a standard `Response`) for HTTP. There is
  no `select` and no custom change type.
- **HTTP fires when the body changes.** Each poll hashes the body (SHA-256 of
  its stable JSON, or of the text when it is not JSON) and compares it with
  the hash stored from the last poll. If the body carries noise like a
  timestamp, the handler reads `response` and returns early.
- **Files fire when a matching file changes.** `files` has `added`,
  `modified`, and `removed`. Globs are polled; `.every` is optional and keeps
  today's default interval.
- If `fn` returns a locked node, the monitor starts it:
  `.do(async ({ response }) => ship({}, { task: (await response.json()).title }))`.
- WebSocket monitors are dropped.

## Composition

Context is layered. Each layer inherits from the one around it and can
override any part of it.

| Layer | Supplies |
| --- | --- |
| 1. Config | The work directory (the config's directory) and its residency: one folder per config under `~/.foundry`, keyed by the config's location |
| 2. Definition | The definition's own defaults, e.g. an agent's prompt, skills, model, provider |
| 3. Workflow | The run |
| 4. Step | The step's stream, log, and signal |
| 5. Call | Options passed at the call, e.g. `agents.session(reviewer, { cwd })` |

The binding happens inside the library. Authors see definitions and overrides,
nothing in between.

### Sessions

- **Fresh by default.** Every `agents.session(…)` starts a new session.
- **Continuing is opt-in, by reference.** Pass the session to continue; a
  session is never looked up by an id the author invents.

  ```ts
  const first = await agents.session(reviewer);
  const again = await agents.session(reviewer, { session: first });  // same messages and tool calls
  const lead = await agents.session(delegator, { session: run.session }); // the run's session
  ```

- **Across runs, the same way.** A session reference is a small serializable
  handle (its id, and the model and provider it opened with), stored in the
  config's residency. To reuse
  one in a later run, a step returns it so it is recorded, and the next run
  passes it back. The docs teach it as a pattern.
- **Providers.** A session belongs to the provider that opened it. Continuing
  it with an agent whose provider differs starts a new session and logs a
  warning.

### Wired by default

Every step runs inside one run, and the run owns one session, one stream,
and one cancellation. Anything a step opens through the context is attached
to them when it is created. The author writes the work; the wiring is
already there.

- **Cancellation propagates.** Cancelling a step aborts its agent turns,
  sandbox commands, and requests. `signal` is still in the context for
  connecting things Quirks does not own, such as a raw `fetch`. Nothing
  Quirks owns needs it passed.
- **Streaming is built in.** Every step has a stream. An agent session opened
  in a step writes its turns to that stream without a `pipe` call. `stream`
  is in the context for the author's own output.
- **The stream is tappable and steerable.** A host watching the run's stream
  (the TUI, the dashboard) can raise a suspension on a running step and hand
  the author's agent a prompt. This is a user-invoked steer, not authored
  code. The mechanism belongs to the run, so it works for any step.
- **The working directory flows.** A session or sandbox opened in a step
  inherits the step's working directory. In a worktree callback, that is the
  worktree.
- **One session per run.** `run.session` is the run's own session. Agents
  opened in the run are attributed to it, and a host reads the run through
  it.

Authored code should read nothing like the current library. A step that
opens an agent and returns its reply is three lines, and all three are about
the work.

#### Layers of cancellation

| Layer | Signal | Fires when |
| --- | --- | --- |
| Run | `run.signal` | The whole run is cancelled, or any step calls `run.abort()`. Everything stops. |
| Step | `signal` | This step is cancelled or paused, or its run is. |
| Turn | internal | A host steers the agent mid-turn. Only the current turn stops. |

Each layer derives from the one above. `run.abort(reason)` is the complete
escape: it fails the run and aborts every step, session, and sandbox in it.

#### Steering and pausing from the stream

A host watching `run.stream` (the TUI, the dashboard) can act on a running
step. Neither is authored code.

- **Steer.** The step keeps running. The host hands a prompt to the agent
  active in that step. The current turn is aborted, the prompt becomes the
  next user message, and the session continues. The author's
  `await session.generate(…)` resolves with the reply to the steered
  conversation. The steer is written to the run stream and the session
  transcript. Nothing replays.
- **Pause.** The host parks the step. Its signal aborts what it opened, and
  a suspension is recorded under the step's path, the same way `ask`
  records one. Resuming, with or without a prompt, replays the body from the
  top. A prompt supplied on resume leads the first turn of the recorded
  session in that step.

Two things are visible in a session's transcript afterwards, by design. A
turn cut short by a steer or a pause is committed with the text it produced
so far and reads as a complete assistant message; the providers have no
"aborted" status. After a pause the replayed body sends its user message
again, so the transcript reads user, partial assistant, user again, assistant.
The dashboard drives all of this with `s`, `p`, and `k` on a selected run or
step, and its Stream tab shows the `[steer]` and `[resume]` markers inline.

#### Writing replayable steps

A step body may run more than once: after a pause, after an `ask`, or on
recovery. The body must reach the same frame again and pick up the live
values it had. Two rules make that automatic:

1. **Open things through the context, in a fixed order.** Each
   `agents.session(…)`, `sandboxes.start(…)`, and `ask.*(…)` in a body is
   numbered by the order it is called. On replay, the same call at the same
   position returns the recorded thing: the same session, with its transcript,
   instead of a new one. Conditionals that change the order break this, as
   with hooks.
2. **Keep effects behind those calls.** Work that must not repeat goes into
   an agent turn, a step of its own, or after the last suspension point.

A session opened this way is recoverable from its own store: the step
replays up to the frame, the session call returns the existing session, and
the next turn continues where it left off.

### Agents, models, and providers

There is no harness concept in the API. The provider is the harness.

- **One models instance per config.** Built when the config loads, with the
  config's providers registered. It owns credentials, defaults, and
  availability. Authors never see it.
- **`model` and `provider` pick the runtime.** `provider: "codex"` runs
  Codex, `provider: "claude-code"` runs Claude Code, and no provider runs the
  built-in harness with the config's default model. Future providers (Pi)
  slot in the same way. Model ids are catalog ids, e.g.
  `anthropic/claude-sonnet-4.6`. Availability is checked at load.
- **The workspace binds the model.** When a session opens, the composed
  working directory is handed to the provider. A CLI provider runs in that
  directory. This is how a session works in a worktree or another workspace.
- **Phase 1 runs in normal space.** No agent runs inside a sandbox yet. See
  [Open](#open).

```ts
const reviewer = agent({ prompt: "Review without editing.", provider: "codex" });
const drafter = agent({ prompt: "Draft the page.", model: "anthropic/claude-sonnet-4.6" });
```

## Mapping to `@foundry/workflows`

| API | Package mechanic |
| --- | --- |
| `.do(fn)` | Called from a Step's `execute` body, after the children finish. |
| Locking a definition | A fresh `Step` per lock. A Step attaches to one parent only. |
| Children | `spec.children`. The package drains children after the body returns, so Quirks wraps the body: the wrapper drains the children, collects their results by key, merges the literal input, then calls `fn`. |
| `.series`, `.parallel` | `Composer`: `sequence`, `parallel` (also `race`, `branch`). |
| Composition | Seed context: a parent's context forks into its children, and per-invocation context overrides create-time context. |
| Keys | Step paths. Siblings read results with `ctx.resultOf(key)`. |
| `stream` | `ctx.write` / `ctx.pipe`, or `yield` from an async generator body. Channels are per run, so any depth reaches the run's stream. |
| `ask.question`, `ask.approval` | A suspension (`suspendForApproval`), resumed by `(stepPath, name, occurrence)`. |
| `report.*` | A run event on the stream plus a persisted entry; `report.artifact` calls `ArtifactSystem.revise`. |
| Names | The Orchestrator registry. Recovery rebuilds runs by name. |
| Persistence, resume | Per-run Snapshot, the queue, `orchestrator.recover()`. |
| Workflow setup | **Differs.** The package makes the body a durable step; this API does not. |

## Open

### Pending design

- **Race, branch, and loops.** After `.parallel`. `ship` used to retry
  implement → review up to three times.
- **Durable setup.** To explore: an opt-in durable setup, and whether setup may
  report or ask, which would repeat on every setup.
- **Sandbox API.** The `@foundry/sandbox` surface is due to change. The
  `sandboxes` key follows it.
- **Shortcuts.** One-call helpers on top of the context: loading a workspace,
  a sandbox handler that returns a sandbox already started, mounted, and scoped
  to the run, or calling an agent directly with its presets.
- **Agents inside a sandbox (phase 2).** Today an agent wraps a sandbox; no
  architecture invokes an agent in one. Phase 2 installs the image, the CLIs,
  and Foundry's own library into the sandbox and drives the providers from
  inside. Host configuration folders (`~/.foundry`, `~/.claude`, `~/.codex`)
  mount read-only from phase 1 on, so the CLIs are already logged in when
  that lands.
- **Skills.** The `skills` word gives the shape (`load`, `add`, a set an
  agent takes). Still open: where global and workspace skills live, how a
  glob is named in the catalog, and how the set loads into a CLI provider
  versus the built-in harness.
- **Built-in provider.** The default provider is the first available CLI
  harness; nothing backs the built-in `@foundry/agents` harness yet.
- **Trigger targets with children.** `schedule(publish.parallel({ … }))`
  and a monitor handler returning such a tree are refused; wrap the tree in
  `workflow(name, tree)`. Lifting that needs anonymous trees to register.
- **Recovery of running runs.** A run parked on an ask survives a quit, a
  crash, or a kill; a run that was mid-body when the process stopped does
  not, yet.

### Follow-ups carried over

Pending decisions from the first library, still open against this API.

- **`AgentSpec` fields Quirks does not wire.** `mcp`, `mesh`, and `tools` are
  accepted by the spec and ignored by the session runtime. Narrow the public
  type, reject them, or implement them.
- **Workspace identity in labels.** Launchd labels are
  `com.foundry.quirks.<key>`; two projects with the same trigger key collide.
  A retained session id shared across repositories has the same problem.
- **Dry runs and launchd.** Decide whether `--dry` should also refuse launchd
  mutations and temporary worktree directories.
- **Run stream retention.** Settled runs keep their event and chunk history
  in memory until the engine stops; long-lived dashboards streaming agent
  output need a trim or a dispose.
- **Release copy.** The authored `first-release.md` introduction needs an
  explicit input to release generation, and the package changelog should
  not carry the whole repository's history.

### Advanced patterns, later

- **Agentic loops by replay.** Two agents in one step: the second judges the
  first's answer and, if it is not good enough, replays the step with more
  context. This needs per-step metadata that survives replay (an attempt
  count, a max, the context added so far). `@foundry/workflows` already
  keeps per-step state in the Snapshot; expose a small slot of it as
  `step.meta` or similar, and let a body request its own replay. Convention
  gives replayability; this pattern uses it on purpose.
- **Ask and report rendering.** How the host shows blocked versus waiting
  runs, and how milestone, result, and artifact entries render.
- **Prebuilt sessions, possibly.** The context may also carry sessions that
  are already set up, ready to use without calling `agents.session(…)`.
- **Package features not yet exposed.** `bail(error)` versus throw, `RetryPolicy`,
  pause and skip, step hooks. The package has no default retry: until a
  policy is exposed, a throw fails the step.
