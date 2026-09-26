# The `@foundry/quirks` authoring API

Everything a `quirks.config.ts` can say, condensed from the maintainer's API
document. Where this page and the running library disagree, the library's
error message is the truth for today and this page is the intent.

## Contents

1. [Top-level words](#top-level-words)
2. [Definitions](#definitions)
3. [The builder](#the-builder)
4. [Locking and trees](#locking-and-trees)
5. [Context](#context)
6. [Triggers](#triggers)
7. [Composition and durability](#composition-and-durability)
8. [CLI](#cli)
9. [Not available yet](#not-available-yet)

## Top-level words

```ts
import {
  agent, artifact, monitor, sandbox, schedule, skills, step, workflow, workspace,
} from "@foundry/quirks";
```

| Word | Kind | Shape | Purpose |
| --- | --- | --- | --- |
| `agent` | definition | `agent({ prompt, model?, provider?, skills? })` | Who does model work, with defaults. |
| `workspace` | definition | `workspace({ path })` | Another directory to work on. The config's own is implicit. |
| `sandbox` | definition | `sandbox({ image, mount?, resources? })` or `sandbox({ files, image? })` | An isolated place to run commands. |
| `artifact` | definition | `artifact({ name, type })` | A versioned output; each run adds a version. |
| `skills` | definition | `skills.load().add(glob).pick(...names)` | A skill set an agent takes. |
| `step` | work | `step(name?).describe(text).input(s).output(s).do(fn)` | One unit of work. |
| `workflow` | work | `workflow(name?, tree)`, `workflow(name?, () => tree)`, `workflow(name?).input(s).do(fn)` | A named tree of steps. |
| `schedule` | trigger | `schedule(target).at(slot)` or `.every(interval)` | Runs a step or workflow on a clock. |
| `monitor` | trigger | `monitor(source).every?(interval).do(fn)` | Runs when files or an HTTP body change. |

Calling a word registers it. Nothing is exported. Singular words are imports;
plural keys (`agents`, `workspaces`, `sandboxes`, `artifacts`) are the context.

## Definitions

Definitions are optional presets. The context can create the same things on
the spot.

```ts
const reviewer = agent({ prompt: "Review without editing.", provider: "codex" });
const drafter = agent({ prompt: "Draft the page.", provider: "claude-code" });
const site = workspace({ path: "../marketing-site" });          // relative to the config
const box = sandbox({ image: "docker.io/oven/bun:1-slim", mount: "." });
const scratch = sandbox({ files: { "main.py": "print(1)" } });  // seeded under /workspace
const weeklyReport = artifact({ name: "Weekly report", type: "text/markdown" });
const reviewing = skills.load().add("./skills/review/*").pick("caveman");
```

- `agent.prompt` is required and should state limits ("read only").
  `provider` is `"codex"` or `"claude-code"`; omitted means the first
  installed CLI. `model` is optional: omit it for the provider's default, or
  set an id the provider serves. It does not pick the provider, and an
  unknown id is passed through with a warning.
- `sandbox` with `image` mounts a workspace read/write at `/workspace`.
  `mount` is `"."` (the default): the step's working directory, which is the
  config's directory or, inside a worktree callback, the worktree. Or a
  declared workspace: `mount: site`. Any other host path is refused at run
  time with `escapes the trusted host roots`. `~/.foundry`, `~/.claude`,
  `~/.codex` mount read-only when they exist. The `files` form mounts nothing
  and copies the files under `/workspace` after boot.
- `skills.load()` is the global and workspace skills; `.add(glob)` appends a
  folder; `.pick(...names)` narrows. Each call returns a new set.

## The builder

```ts
step(name?)          // a builder
  .describe(text)    // optional: shown in the catalog and launch form
  .input(schema)     // optional: any Standard Schema library (zod, valibot, arktype)
  .output(schema)    // optional
  .do(fn)            // returns the definition
```

- A string first argument makes the step launchable by that name. A repeated
  name fails at load. Without a name the step is internal unless the
  project's `typescript` resolves from the config's directory, in which case
  a step assigned to a top-level `const` takes that name.
- Schemas come before `.do()` so the body is typed from them. No input
  schema means an empty launch form.
- A parent declares its children's results in `.input()` like any other
  input. Each child's output is checked against the parent's key at lock.
- `do` receives one object; destructure it.

`workflow` uses the same builder plus two short forms:

```ts
workflow("weekly", publish.parallel({ findings: review({}), exitCode: test({}) }));
workflow("nightly", () => publish({ findings: review({}, { target: "src" }) }));
workflow("ship").input(z.object({ task: z.string() })).do(({ input: { task } }) =>
  approve({ review: review({ branch: implement({}, { task }) }) })
);
```

A workflow's `.do` is setup: it receives `{ input, log, run: { id } }` only,
and returns the tree.

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
  `{}`.
- **Input second, optional.** Literal values for the step's input.
- The children's results and the literal input merge into the body's `input`.
  A key in both is an error at load.
- The parent runs last, after its children. Siblings are independent; data
  flows only child to parent.
- One definition can be locked many times; each lock is its own node.
- `.parallel` is the only combinator besides the default series. No race,
  branch, or loop yet.

## Context

The one object every step body receives:

```ts
step().do(async ({ input, agents, workspaces, sandboxes, artifacts, ask, report, log, stream, signal, run }) => …);
```

| Key | What it is |
| --- | --- |
| `input` | Typed input, validated against `.input(schema)`. |
| `agents` | `session(def, { cwd?, session?, compaction? })` → `{ generate(prompt) → { text }, stream(prompt), ref, harness }`. |
| `workspaces` | `current` (the config's directory) and `load(def | { path })` → `{ root, files(), git }`. |
| `sandboxes` | `start(def | spec)` → `{ exec(argv) → { exitCode, stdout, stderr }, close(), id }`; `open(id)`. |
| `artifacts` | `write(def, files)` adds a version; `create({ name, type, entries })` makes one on the spot. |
| `ask` | `approval({ title, body? })` → `{ approved, note? }`; `question({ title, body?, choices? })` → `string`. |
| `report` | `milestone({ title, body? })`, `result({ title, body, media? })`, `artifact(def, files, entry?)` → version. |
| `log` | `log(...values)`, `log.warn(...)`, `.info`, `.debug`, `.error`. |
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

- `approval` is a hard block: the run shows as blocked until someone decides.
  `question` is input: the step waits, siblings keep going. Both need a
  process that can show them: the dashboard parks the run; `once` and a
  launchd tick cancel it at the ask. `choices` gives a
  pick list; without it the answer is free text. Both are identified by
  position in the body; `key` is optional, for updating one entry across
  steps.
- Reports are fire-and-forget entries on the run.
- Everything Quirks owns is already cancelled with the step and already
  writes to the step's stream. `signal` and `stream` are for the author's own
  work.

A monitor's handler gets the same object (`workspaces`, `agents`, `report`,
`log`, …) with `files` or `response` in place of `input`. `files` is
`{ added, modified, removed }`, each a `{ path, checksum }[]` with `path`
relative to the config's directory; read one with `node:fs` from
`resolve(workspaces.current.root, path)`. `response` is a standard
`Response` over the polled body.

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

- `schedule(target)`: a named step or workflow, bare or a childless lock. A
  lock carries its input. `.at(slot)` or `.every(interval)` is the terminal
  call. `weekday` is `"sun"…"sat"` or an array; omit it for every day.
- `monitor(source)`: one string. `http://` or `https://` polls and fires when
  the body changes (hashed). Anything else is a glob over the config's
  directory, polled; `.every` defaults to one minute. `.do(fn)` is terminal.
- A handler that returns a locked node (`ship({}, { task })`, `nightly({})`)
  starts it, attributed to the monitor. One node per tick: several new files
  in one poll either batch into one input or wait for the author to pick.
  A returned bare definition is ignored; return `undefined` to do nothing.
  Started is delivered: the monitor holds the launch until a tick has
  started it (a start that fails for now is retried next tick; a target no
  longer registered is dropped after one), and a started run that then
  fails or is cancelled is not started again, any more than a schedule's
  run would be.
- The first poll has no baseline: every matching file is `added`, or the
  first body counts as a change, so the handler runs once on first start.
- Keys: a schedule is `slug(target)[-sha8(input)]`, a monitor
  `slug(source)-sha6(source)`. `quirks list` prints them.

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
  replay. Keep their order fixed; keep effects behind them.
- **Workflow setup is not durable.** It runs on every setup and rebuilds the
  tree. Pass what it must keep into a step as input: a run records the
  input each step was locked with when it started, and a recovered run
  keeps those, whatever setup would compute now.
- **Sessions are fresh by default.** Continue one by reference (`{ session }`),
  never by an invented id. Across runs, return `session.ref` and pass it back.
- **A run owns one session, one stream, one cancellation.** Everything opened
  through the context is attached to them.
- **Hosts can steer and pause.** The dashboard's `s` hands a prompt to the
  agent mid-turn, `p` parks the step and everything under it (the bodies
  replay on resume), `k` cancels. A step parks once its attempt has stopped:
  agent turns, sandbox commands, and worktrees stop at the signal, so a body
  that waits on something else should honour `signal` or it delays the
  pause, and likewise a failure or a cancel, until it returns. None of it
  is authored code.

## CLI

```sh
quirks [--config ./quirks.config.ts] [--dry] [--state ~/.foundry/quirks]
quirks list                       # named steps, workflows, schedule keys, monitor keys
quirks once <name-or-key> [--input '{"target":"src"}']
quirks status                     # every workspace under --state
quirks sessions                   # this workspace's agent sessions
quirks launchd install <key>      # macOS agent for one schedule or monitor
```

- No subcommand opens the dashboard and starts the triggers.
- `--dry` echoes every agent turn, git mutation, and sandbox command, and
  keeps no state. Agent turns return the echoed prompt as `text`; sandbox
  commands return exit 0 with empty output. Custom code in step bodies still
  runs.
- The CLI supplies `@foundry/quirks` to the config module itself; a schema
  library such as `zod` must resolve from the config's directory.

## Not available yet

Do not write configs that depend on these.

- Race, branch, and loops between steps. Only series and parallel.
- A built-in model provider. No `provider` means the first installed CLI.
- Agents running inside a sandbox. An agent may drive a sandbox, not live in it.
- Recovery of a step that was mid-body when the process stopped. A step
  parked on an `ask` or a pause does survive a quit, a crash, or a kill.
- Scheduling a tree with children without wrapping it in `workflow`.
- Retry policies. A throw fails the step.
- `@foundry/quirks` on npm.
