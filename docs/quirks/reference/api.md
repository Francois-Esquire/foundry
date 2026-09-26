---
title: API reference
description: The nine words of quirks.config.ts, the builder, locking, the context, triggers, and what replays.
---

Everything a `quirks.config.ts` can say. Where this page and the running
library disagree, the library's error message is the truth for today.

## The nine words

```ts
import {
  agent, artifact, monitor, sandbox, schedule, skills, step, workflow, workspace,
} from "@foundry/quirks";
```

| Word | Kind | Shape | Purpose |
| --- | --- | --- | --- |
| `agent` | definition | `agent({ prompt, model?, provider?, skills? })` | Who does model work, with defaults. |
| `workspace` | definition | `workspace({ path })` | Another directory to work on. The config's own is implicit. |
| `sandbox` | definition | `sandbox({ image, mount?, resources? })` or `sandbox({ files, image?, resources? })` | An isolated place to run commands. |
| `artifact` | definition | `artifact({ name, type })` | A versioned output; each run adds a version. |
| `skills` | definition | `skills.load().add(glob).pick(...names)` | A skill set an agent takes. |
| `step` | work | `step(name?).describe(text).input(s).output(s).do(fn)` | One unit of work. |
| `workflow` | work | `workflow(name?, tree)`, `workflow(name?, () => tree)`, `workflow(name?).input(s).do(fn)` | A named tree of steps. |
| `schedule` | trigger | `schedule(target).at(slot)` or `.every(interval)` | Runs a step or workflow on a clock. |
| `monitor` | trigger | `monitor(source).every?(interval).do(fn)` | Runs when files or an HTTP body change. |

Calling a word registers it. Nothing is exported. Singular words are
imports; the plural keys `agents`, `workspaces`, `sandboxes`, and `artifacts`
are the context a step body receives.

## Definitions

Definitions are optional presets. The context can create the same things on
the spot.

```ts
const reviewer = agent({ prompt: "Review without editing.", provider: "codex" });
const drafter = agent({ prompt: "Draft the page.", model: "sonnet" });
const site = workspace({ path: "../marketing-site" });          // relative to the config
const box = sandbox({ image: "docker.io/oven/bun:1-slim", mount: "." });
const scratch = sandbox({ files: { "main.py": "print(1)" } });  // seeded under /workspace
const weeklyReport = artifact({ name: "Weekly report", type: "text/markdown" });
const reviewing = skills.load().add("./skills/review/*").pick("caveman");
```

- **`agent`.** `prompt` is required and should state limits ("read only").
  `provider` is `"codex"` or `"claude-code"`; omitted means the first
  installed CLI, Claude Code before Codex. `model` names a model the
  provider serves: `sonnet`, `opus`, `haiku`, or `fable` through Claude Code,
  `gpt-5.5` through Codex. It does not pick the provider; an id the provider
  does not know is passed through with a warning, and `--dry` rejects it.
  `skills` takes a skill set.
- **`workspace`.** A directory preset. It has no state or dashboard entry of
  its own. A sandbox may mount it.
- **`sandbox`.** The image form mounts a workspace read/write at `/workspace`.
  `mount` is `"."`, the default, meaning the step's working directory: the
  config's directory, or the worktree inside a worktree callback. Or a
  declared workspace, `mount: site`. Nothing else is mountable; another host
  path fails at run time with `escapes the trusted host roots`. `~/.foundry`,
  `~/.claude`, and `~/.codex` mount read-only when they exist. The `files`
  form mounts nothing and copies its files under `/workspace` after boot.
  `resources` takes `cpus` and `memoryBytes`. Running a sandbox needs the
  optional `microsandbox` peer; `--dry` echoes commands without it.
- **`artifact`.** A declared artifact keeps its identity across runs; each
  `report.artifact` or `artifacts.write` adds a version to it.
- **`skills`.** `skills.load()` is the global set under `~/.foundry/skills`
  plus the workspace's `skills/` folder. `.add(glob)` appends every folder
  matching the glob that holds a `SKILL.md`. `.pick(...names)` narrows.
  Each call returns a new set.

## The builder

```ts
step(name?)          // a builder
  .describe(text)    // optional: shown in the catalog and the launch form
  .input(schema)     // optional: any Standard Schema library (zod, valibot, arktype)
  .output(schema)    // optional
  .do(fn)            // returns the definition
```

- A string first argument makes the step launchable by that name. A repeated
  name fails at load. Without a name the step takes the name of the top-level
  `const` it is assigned to when the project's `typescript` resolves from the
  config's directory; otherwise it is internal. See
  [names and the catalog](/quirks/reference/configuration#names-and-the-catalog).
- Schemas come before `.do()` so the body is typed from them. `.input()`
  gives the TypeScript type, validation at launch, the dashboard's launch
  form, and a contract the catalog can read. No input schema means no launch
  input. `.output()` validates the body's return.
- A parent declares its children's results in `.input()` like any other
  input. Each child's output is checked against the parent's key at lock.
- `do` receives one object; destructure it. It may return a value or a
  promise. Results must be JSON-serializable.

`workflow` uses the same builder plus two short forms:

```ts
workflow("weekly", publish.parallel({ findings: review({}), exitCode: test({}) }));
workflow("nightly", () => publish({ findings: review({}, { target: "src" }) }));
workflow("ship").input(z.object({ task: z.string() })).do(({ input: { task } }) =>
  approve({ review: review({ branch: implement({}, { task }) }) })
);
```

A workflow's `.do` is setup: it receives `{ input, log, run: { id } }` only
and returns the tree. It is not durable; see
[composition and durability](#composition-and-durability).

## Locking and trees

A definition has two phases. Build (`step()…do()`) shapes it. Lock (calling
it) puts one node in a graph.

```ts
review({}, { target: "." });                          // leaf: no children, literal input
publish({ findings: review({}) }, { exitCode: 0 });   // one child, one literal
publish.series({ a: x({}), b: y({}) });               // children in key order (default)
publish.parallel({ a: x({}), b: y({}) });             // children together
```

- **Children first.** An object of locked nodes keyed by name. A leaf passes
  `{}`. The keys name the children in the dashboard, in logs, on resume, and
  in the parent's input.
- **Input second, optional.** Literal values for the step's input. The
  literal takes the schema's input type, so defaulted fields are optional.
- The children's results and the literal input merge into the body's
  `input`. A key in both is an error at load, as is a child key the parent's
  schema does not declare.
- The parent runs last, after its children. Siblings are independent; data
  flows only from a child to its parent. A step that needs another's result
  takes it as a child.
- One definition can be locked many times; each lock is its own node.
- `.parallel` is the only combinator besides the default series. There is no
  race, branch, or loop yet. A workflow is a definition too: `weekly({})`
  locks it.

In a parallel group the first failure fails the run; the siblings are
aborted and awaited before the failure is reported. A sibling that parks on
a question parks the parent with it while the others finish.

## Context

The one object every step body receives:

```ts
step().do(async ({ input, agents, workspaces, sandboxes, artifacts, ask, report, log, stream, signal, run }) => …);
```

| Key | What it is |
| --- | --- |
| `input` | Typed input, validated against `.input(schema)`. |
| `agents` | `session(def, { cwd?, session?, compaction? })` → `{ generate(prompt) → { text, … }, stream(prompt), ref, harness }`. |
| `workspaces` | `current` (the config's directory) and `load(def \| { path })` → `{ root, files(), git }`. |
| `sandboxes` | `start(def \| spec)` → `{ exec(argv) → { exitCode, stdout, stderr }, close(), id }`; `open(id)`. |
| `artifacts` | `write(def, files)` adds a version; `create({ name, type, entries })` makes one on the spot. |
| `ask` | `approval({ title, body?, key? })` → `{ approved, note? }`; `question({ title, body?, choices?, key? })` → `string`. |
| `report` | `milestone({ title, body?, media?, key? })`, `result(entry)`, `artifact(def, files, entry?)` → version. |
| `log` | `log(...values)` at info; `log.debug`, `.info`, `.warn`, `.error` pick a level. |
| `stream` | `write(value)`, `pipe(source)`. The step's live output. |
| `signal` | Fires when this step is cancelled or paused, or its run is. |
| `run` | `{ id, path, session, signal, stream, abort(reason) }`. Advanced only. |

```ts
const session = await agents.session(reviewer);                        // fresh session
const scoped = await agents.session(reviewer, { cwd: worktree.root });  // override cwd
const again = await agents.session(reviewer, { session });              // continue one
const reply = await session.generate("Review the change.");
reply.text;

const here = workspaces.current;
await here.git.withWorktree({ base: "main", branch: "task/x" }, async (worktree) => {
  // worktree.root, worktree.branch (null when detached); removed on return
});

const env = await sandboxes.start(box);
const result = await env.exec(["bun", "test"]);

const { approved, note } = await ask.approval({ title: "Merge it?", body: review });
const region = await ask.question({ title: "Which region?", choices: ["us", "eu"] });
const free = await ask.question({ title: "Anything to add?" });          // free text

report.milestone({ title: "Tests green" });
report.result({ title: "Summary", body: markdown });
const version = await report.artifact(weeklyReport, { "report.md": markdown });

stream.write("Tag ready\n");
await fetch(url, { signal });
```

- **Agents.** A session's turns write to the step's stream and stop with the
  step. `generate` returns the message with a `text` field; `stream` returns
  the harness's stream. `ref` is a small serializable handle (`id`, and the
  `model` and `provider` it opened with) for continuing the session later.
  `compaction: true` summarizes older history with the turn model.
- **Workspaces.** `current.git` throws when the config's directory is not a
  repository. `withWorktree({ base, branch?, home? }, body)` cuts a checkout
  under the workspace's state, runs `body` with the working directory
  narrowed to it, and removes it on return; a `branch` outlives the worktree.
- **Ask.** `approval` is a hard block: the run shows as blocked until someone
  decides. `question` is input: the step waits, siblings keep going. Both
  need a process that can show them; the dashboard parks the run, while
  `once` and a launchd tick cancel it at the ask. `choices` gives a pick list
  of at most nine; without it the answer is free text. Both are identified
  by position in the body; `key` is optional, for updating one entry across
  steps.
- **Report.** Entries are fire-and-forget and land on the run and the feed.
  `media` paths resolve from the config's directory and are copied into the
  entry; refer to them in the body as `media/<file name>`. `report.artifact`
  writes a version, posts a result entry titled after the artifact unless
  `entry.title` says otherwise, and returns the version.
- **Signal and stream.** Everything Quirks owns is already cancelled with the
  step and already writes to the step's stream. `signal` and `stream` are for
  the author's own work: a raw `fetch`, a child process, a line of output.
- **Run.** `run.abort(reason)` fails the whole run. `run.session` is the
  run's own session; agents opened in the run are children of it.
  `run.stream` is the whole run's output. Everyday code never reads `run`.

A monitor's handler gets the same object with `files` or `response` in place
of `input`, plus `change`. `files` is `{ added, modified, removed }`, each a
`{ path, checksum }[]` with `path` relative to the config's directory; read
one with `node:fs` from `resolve(workspaces.current.root, path)`. `response`
is a standard `Response` over the polled body. `change` carries the diff:
the file lists, or `{ status, previous, current }` for HTTP.

## Triggers

```ts
schedule(weekly).at({ weekday: "fri", hour: 16, minute: 0 });   // machine-local time
schedule(review({}, { target: "packages" })).every("6h");        // "30s" | "10m" | "6h" | "1d"

monitor("docs/**/*.md").do(({ files, log }) => log(files.modified));
monitor("https://status.example.com/api").every("5m").do(async ({ response, report }) => {
  const { status } = await response.json();
  report.milestone({ title: `Status: ${status}` });
});
monitor("https://tracker.example.com/latest").every("10m")
  .do(async ({ response }) => ship({}, { task: (await response.json()).title }));
```

- **`schedule(target)`** takes a named step or workflow, bare or as a
  childless lock. A lock carries its input, so there is no input field. A
  lock with children throws `wrap it in workflow(name, tree) first`; a
  nameless target throws `has no name`. `.at(slot)` or `.every(interval)` is
  the terminal call. `weekday` is `"sun"` through `"sat"` or an array; omit
  it for every day. `minute` defaults to zero. An interval is an integer
  with `s`, `m`, `h`, or `d`.
- **`monitor(source)`** takes one string. `http://` or `https://` is polled
  and fires when the body changes: each poll hashes the body, as stable JSON
  when it parses, as text otherwise, and compares it with the last hash. A
  body that carries noise such as a timestamp fires every poll; read
  `response` and return early when nothing of interest changed. Anything
  else is a glob over the config's directory, polled; `files` lists what was
  added, modified, or removed since the last poll. `.every` defaults to one
  minute. `.do(fn)` is terminal.
- **A handler that returns a locked node starts it**, attributed to the
  monitor: `ship({}, { task })` or `nightly({})`. The same rule applies as
  for schedules: a named definition or a childless lock of one. A bare
  definition is ignored; return `undefined` to do nothing. One node per tick.
  The launch is held as pending until a tick has started it, so a crash in
  between hands it out again; a target no longer registered is dropped after
  one failed tick; a started run that fails or is cancelled is not started
  again.
- **The first poll has no baseline.** Every matching file is `added`, or the
  first body counts as a change, so the handler runs once on first start. A
  glob that matches nothing fires nothing.
- **Keys.** A schedule is keyed `slug(target)[-sha8(input)]`, a monitor
  `slug(source)-sha6(source)`; an exact duplicate gets `-2`. `list` prints
  the keys. They name the state files, the launchd label, and `once <key>`.

## Composition and durability

Context is layered: config (its directory and its state folder under
`~/.foundry`) → definition (prompt, provider, model) → workflow (the run) →
step (stream, log, signal) → call (`{ cwd }`, `{ session }`). Inner layers
override outer ones.

- **Steps are durable once finished.** A finished step returns its recorded
  result instead of running again.
- **A suspended step is not finished.** After an `ask`, a pause, or a
  restart, the body replays from the top. `agents.session`, `sandboxes.start`,
  and `ask.*` are numbered by call order and return the recorded thing on
  replay: the same session with its transcript, the recorded answer. Keep
  their order fixed; keep effects that must not repeat behind them, inside
  an agent turn, or in a step of their own. Branching on `input` is safe;
  branching on live values around these calls is not.
- **Workflow setup is not durable.** It runs on every setup and rebuilds the
  tree. Pass what it must keep into a step as input: a run records the
  input each step was locked with when it started, and a recovered run
  keeps those, whatever setup would compute now.
- **Sessions are fresh by default.** Continue one by reference,
  `{ session }`, never by an invented id. Across runs, return `session.ref`
  and pass it back. A ref belongs to the provider that opened it; continuing
  it with an agent on another provider starts a new session and logs a
  warning.
- **A run owns one session, one stream, one cancellation.** Everything
  opened through the context is attached to them. Cancelling a step aborts
  its agent turns, sandbox commands, and worktree callbacks. The working
  directory flows: a session or sandbox opened inside a worktree callback
  runs in the worktree.
- **Hosts can steer and pause.** The dashboard's `s` hands a prompt to the
  agent mid-turn: the turn stops, the prompt becomes the next message, and
  the author's `await generate()` resolves with the steered reply. `p` parks
  the step and everything under it; resume replays the bodies. `k` cancels.
  A step parks, fails, or cancels only once its attempt has stopped: owned
  calls reject at the signal, so a body that waits on something else should
  honour `signal` or it delays the report until it returns. None of this is
  authored code.

## Exports

The package exports the nine words and the types behind them: `Context`,
`StepDefinition`, `WorkflowDefinition`, `LockedNode`, the definition types
(`AgentDefinition`, `WorkspaceDefinition`, `SandboxDefinition`,
`SandboxSpec`, `ArtifactDefinition`, `SkillSet`), the context types
(`Agents`, `Session`, `SessionRef`, `SessionReply`, `Workspaces`,
`WorkspaceHandle`, `Sandboxes`, `Sandbox`, `Artifacts`, `ArtifactVersion`,
`Ask`, `Approval`, `Report`, `Stream`, `Run`, `Log`, `LogLevel`), and the
trigger types (`Schedule`, `ScheduleBuilder`, `MonitorBuilder`,
`CalendarSlot`, `Weekday`, `Trigger`, `MonitorContext`, `MonitorHandler`,
`Change`, `FileChange`, `HttpChange`). `@foundry/quirks/prebuilt` exports the
[prebuilt step factories](/quirks/reference/configuration#prebuilt-steps).

## Not available yet

Do not write configs that depend on these.

- Race, branch, and loops between steps. Only series and parallel.
- A built-in model provider. No `provider` means the first installed CLI.
- Agents running inside a sandbox. An agent may drive a sandbox, not live in
  it.
- Recovery of a step that was mid-body when the process stopped. A step
  parked on an `ask` or a pause does survive a quit, a crash, or a kill.
- Scheduling a tree with children without wrapping it in `workflow`.
- Retry policies. A throw fails the step.
- `@foundry/quirks` on npm.
