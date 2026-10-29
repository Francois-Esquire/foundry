---
title: API reference
description: Authoring factories, builders, resource operations, context properties, and triggers.
---

Use this page to look up authoring options. [Foundation](/marbles/foundation/api)
explains the relationships between definitions, instances, and contexts.
[Agent sessions](/marbles/reference/agent-sessions) covers advanced session options.

[Durability](/marbles/foundation/durability) defines the execution guarantees;
[Foundry primitives](/marbles/foundation/primitives) maps these operations
to the libraries beneath them. Package APIs can expose capabilities beyond
the authoring interface described here.

Code blocks on this page illustrate API forms and may refer to definitions
from earlier blocks. For complete runnable modules, use the
[quickstart](/marbles/get-started/quickstart) or [composition examples](/marbles/foundation/composition).

## Authoring factories

```ts
import {
  agent,
  artifact,
  monitor,
  sandbox,
  schedule,
  skills,
  step,
  workflow,
  workspace,
} from "@foundry.sh/marbles";
```

| Factory | Declaration | Purpose |
| --- | --- | --- |
| `agent` | `agent({ name?, prompt, model?, provider?, settings?, skills? })` | Who does model work, with defaults. |
| `workspace` | `workspace({ path })` | Another directory to work on. The current workspace is implicit. |
| `sandbox` | `sandbox({ image, mount?, target?, … })` or `sandbox({ files, image?, … })` | An isolated place to run commands. |
| `artifact` | `artifact({ name, type })` | A named output; each write adds a version. |
| `skills` | `skills.load().add(glob).pick(...names)` | A skill set an agent takes. |
| `step` | `step(name?).describe(text).input(s).output(s).config(c).do(fn)` | One piece of work. |
| `workflow` | `workflow(name?, tree)`, `workflow(name?, () => tree)`, `workflow(name?).input(s).do(fn)` | A named tree of steps. |
| `schedule` | `schedule(target).at(slot)` or `.every(interval)` | Runs a step or workflow on a clock. |
| `monitor` | `monitor(source).request?(init).every?(interval).do(fn)` | Runs when files or an HTTP response change. |

Steps, workflows, and triggers register as modules load. Exports are optional
and useful for sharing definitions. Import singular factories to declare resources. A step uses the plural
context properties `agents`, `workspaces`, `sandboxes`, and `artifacts` to
operate on them.

## Definitions

Resource declarations collect reusable settings. Some context methods also
accept those settings inline. Returned instances expose operations such as
`generate`, `files`, and `write`; see [Using a definition](#using-a-definition).

```ts
const reviewer = agent({
  prompt: "Review without editing.",
  provider: "codex",
});
const drafter = agent({ prompt: "Draft the page.", provider: "claude-code" });
const site = workspace({ path: "../marketing-site" }); // relative to the workspace root
const box = sandbox({ image: "docker.io/oven/bun:1-slim", mount: "." });
const scratch = sandbox({ files: { "main.py": "print(1)" } }); // seeded under /workspace
const weeklyReport = artifact({ name: "Weekly report", type: "text/markdown" });
const reviewing = skills.load().add("./skills/review/*").pick("caveman");
```

### Agent settings

`prompt` is required. State the agent's task and limits, such as "Review
without editing."
`provider` is `"codex"`, `"claude-code"`, or `"pi"`; omitted means the first
installed CLI, Claude Code before Codex. `model` is optional: omit it for
the provider's default, or set an id the provider serves. It does not pick
the provider; an id the provider does not know is passed through with a
warning, and `--dry-run` rejects it. `skills` takes a skill set.

Tool grants and agent-created triggers are stored under the agent's ID: `name`
when given, else the top-level `const` it is assigned to, else `agent-`
and a digest of its prompt. Two agents with one id and different prompts
fail at load with `already declared … with a different prompt`; the same
agent declared twice is fine, on any route.

### Workspace settings

A workspace declaration selects a directory. It creates no dashboard entry
or separate runtime state. A sandbox may mount the directory.

### Sandbox settings

The image form mounts a workspace read/write at `/workspace`. `mount: "."`
uses the step's working directory, including its current Git worktree. A
sandbox can also mount a declared workspace, such as `mount: site`. Other
host paths fail with `escapes the trusted host roots`.

The files form mounts no host workspace. It copies its seed files under
`/workspace` after boot. Host authentication and state directories are never
mounted automatically. Workspace mounts require `executable: true` to run
files; network access defaults to disabled.

`target` selects the mount location; `workdir` selects the working directory.
Other container options are `network`, `ports`, `labels`, `publicEnvironment`,
`detached`, and `resources: { cpus?, memoryBytes?, pids? }`. Running a sandbox
requires the optional `microsandbox` peer. Dry execution echoes commands
without starting it.

### Artifact identity

A declared artifact keeps its identity across runs; each
`report.artifact` or `artifacts.write` adds a version to it.

### Skills

`skills.load()` is the global set under `~/.foundry/skills`
plus the workspace's `skills/` folder; `skills.none()` starts empty.
`.add(glob)` appends every folder matching the glob that holds a
`SKILL.md`, and `.add(skill)` appends a skill defined in code with
`defineSkill({ manifest, files? })`, exported from `@foundry.sh/marbles`.
`.pick(...names)` narrows. Each call returns a new set. A skill's files
are read as bytes: text stays text, and an agent loading a binary file
is told its size rather than shown mangled bytes.

## Using a definition

Inside a step, call an agent instance for a single turn:

```ts
const reply = await reviewer.generate("Review this change.");
const stream = reviewer.stream("Review the next change.");
```

Use `.run(input)` to execute a step directly. This excerpt assumes `z` is
imported from `zod`:

```ts
const countLines = step("count-lines")
  .input(z.object({ text: z.string() }))
  .do(({ input }) => input.text.split("\n").length);

const lines = await countLines.run({ text: "First line\nSecond line" });
```

| Instance | Operations | Context equivalent |
| --- | --- | --- |
| `agent` | `generate(input, turn?)`, `stream(input, turn?)`; `extend({ model?, provider?, settings? })` | `agents.session(def)`, one turn |
| `step`, `workflow` | `run(input?)` | Direct execution within the current process; no separate dashboard run. |
| `workspace` | `root`, `files()`, `git` | `workspaces.load(def)` |
| `sandbox` | `exec`, `close`, and the container's `commands`, `filesystem`, `processes`, `shell`, `ports`, `services`, `volumes`; started by the first call | `sandboxes.start(def)` |
| `artifact` | `write(files, options?)`, `latest()` | `artifacts.write(def, files)`, `artifacts.latest(def)` |

- Inside a step, instance methods use its working directory, output, and
  cancellation. Replay depends on the operation: managed artifact writes
  and completed one-shot agent replies can be reused; file reads and
  commands can execute again. Keep managed call order stable. See the
  [replay table](/marbles/foundation/durability#replay-is-different-from-retry).
- **Anywhere else** (module top level, a plain `bun` script) it runs on the
  engine `marbles` built for the module, or, with none, on a default one:
  the installed CLI harnesses, the current directory as the workspace, and
  the shared artifact store under `~/.foundry/artifacts`. Call `dispose()`
  from `@foundry.sh/marbles` when a script is done with it; a Codex turn keeps
  a child process open until then.
- **An agent's call is one turn on a fresh session.** For a conversation,
  open a session with `agents.session(designer)`. The data fields are plain
  properties and the methods are not, so `{ ...designer }` is a plain
  definition that `agents.session` takes.
- **`extend` changes only the route and settings.** It returns an agent
  with the same ID, prompt, and skills. `settings` merge over the base's:
  plain objects merge recursively, and any value `extend` sets replaces the
  one before; arrays and `output` are replaced whole. A new `output` types
  the extended agent's replies. See
  [choosing the route when the step runs](/marbles/foundation/agents-and-sessions#choose-the-route-when-the-step-runs).
- **A sandbox starts at its first call.** In a step it is that step's
  sandbox, closed with the run and reopened on replay; elsewhere it runs
  until `close()` or `dispose()`. Its filesystem is `box.filesystem`, since
  a files sandbox's `files` is the seed it was declared with. `agents.session(def, { sandbox: box })`
  takes the declared sandbox and starts it the same way.
- **`run` runs in this process**, not through the engine's queue, so a body
  can await it; a nameless definition runs too. The nested run is not shown
  on the dashboard and cannot be paused on its own. A step that asks a
  person with nobody to answer rejects with `asked a person; run it with
  marbles to answer`.

## The builder

A builder ends with either `.do(body)` or `.exec(command)`. The forms below
show the available options, not a single executable chain.

```ts
step(name?)          // a builder
  .describe(text)    // optional: shown in the catalog and the launch form
  .input(schema)     // optional: any Standard Schema library (zod, valibot, arktype)
  .output(schema)    // optional
  .config({ retry?, timeout? }) // optional: how the step runs
  .do(fn)            // returns the definition
  // or, for a step that is one command:
  .exec("bun add $package", { check?, cwd?, environment?, sandbox? })
```

- A string first argument makes the step launchable by that name. A repeated
  name fails at load. Without a name the step takes the name of the top-level
  `const` it is assigned to when the project's `typescript` resolves from the
  workspace root; otherwise it is internal. See
  [names and the catalog](/marbles/reference/project#names-and-the-catalog).
- Schemas come before `.do()` so the body is typed from them. `.input()`
  gives the TypeScript type, validation at launch, a contract the catalog can read, and (with Standard JSON Schema support)
  structured fields in the dashboard launch form. Other input schemas use
  a JSON field. No input schema means no launch
  input. `.output()` validates the body's return.
- A parent declares its children's results in `.input()` like any other
  input. Each child's output is checked against the parent's key at lock.
- `do` receives one object; destructure it. It may return a value or a
  promise. Results must be plain JSON: a step whose result holds a `Date`,
  a `Map`, or a class instance fails with where it stops being JSON
  (`files[0].updatedAt is a Date`). Return an ISO string for a date.
- **`.config({ retry, timeout })`.** `timeout` bounds each attempt of the
  body (`"30s"`, `"10m"`, or milliseconds): when it passes the body's
  `signal` aborts, with everything Marbles opened for it, and the attempt
  fails. `retry` is the [Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md) policy, `{ maxAttempts,
  backoff?, maxElapsed?, shouldRetry? }`, with `backoff` one of `fixed`,
  `exponential`, `linear`, or `jittered`. A retried attempt runs the body
  again from the top, fresh: agent turns, sandboxes, artifact writes, and
  `run` calls it made are not replayed. Children that finished are not run
  again. `maxAttempts` includes the first attempt. Neither retries nor a
  timeout are enabled by default, and a parent's policy does not become
  its children's policy. Without `retry`, a throw fails the step.
- **`.exec(template, options?)`** ends a step whose work is one command.
  The template is split into arguments when the module loads, honouring
  quotes, and never read by a shell. `$name` fills one argument from the
  input, never split again, so `{"package":"two words"}` is one
  package argument; an array fills one argument per element. The program, the
  first word, must be written out, and each placeholder must be an input
  key, or the module fails to load. `.exec(({ input }) => argv)` computes
  the list instead. The step's output is `{ exitCode, stdout, stderr }`; a
  non-zero exit fails it unless `{ check: false }`. It runs like a body's
  `exec`.
- **`bail(error)`**, exported from `@foundry.sh/marbles`, is a failure as a
  value: return it from `do` to fail the step without a retry. It is not
  checked against the output schema.

`workflow` uses the same builder plus two short forms:

```ts
workflow(
  "weekly",
  publish.parallel({ findings: review({}), exitCode: test({}) })
);
workflow("nightly", () => publish({ findings: review({}, { target: "src" }) }));
workflow("ship")
  .input(z.object({ task: z.string() }))
  .do(({ input: { task } }) =>
    approve({ review: review({ branch: implement({}, { task }) }) })
  );
```

A workflow's `.do` is setup: it receives `{ input, log, run: { id } }` only
and returns the tree. It is not durable; see
[composition and durability](#composition-and-durability).

## Locking and trees

Calling a definition creates a node in the workflow tree. This operation is
called locking. It selects children and literal input without executing work.

```ts
review({}, { target: "." }); // leaf: no children, literal input
publish({ findings: review({}) }, { exitCode: 0 }); // one child, one literal
publish.series({ a: x({}), b: y({}) }); // children in key order (default)
publish.parallel({ a: x({}), b: y({}) }); // children together
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
  locks it. A workflow lock is only ever the root of a run, launched,
  scheduled, or returned by a monitor. As a child in another tree it throws
  `a workflow can only be the root of a run`.

In a parallel group the first failure fails the run; the siblings are
aborted and awaited before the failure is reported. A sibling that parks on
a question parks the parent with it while the others finish.

## Context

Workflow setup receives only `{ input, log, run: { id } }`. Step bodies
receive the full context below. Monitor handlers extend it with change
data. See [Contexts](/marbles/foundation/contexts) for when each is used.

| Property | Use |
| --- | --- |
| `input` | Validated literal input and child results. |
| `exec` | [Run a command](#commands). |
| `agents` | [Open an agent session](#agent-sessions). |
| `workspaces` | [Read files and create Git checkouts](#workspace-operations). |
| `sandboxes` | [Start and use an isolated environment](#sandbox-operations). |
| `artifacts` | [Write and read versioned outputs](#artifact-operations). |
| `ask` | [Wait for a person](#questions-and-approvals). |
| `report` | [Post results to the Feed](#reports). |
| `log`, `stream` | [Write output](#output-and-cancellation). |
| `signal` | Observe cancellation or pause of this step or its run. |
| `run` | [Identify or abort the run](#run-information). |

### Commands

```ts
const result = await exec(["bun", "test"], { check: false });
```

`exec(argv, { check?, cwd?, environment?, sandbox? })` returns
`{ exitCode, stdout, stderr }`. It runs an argument list in the step's working
directory, streams output, and stops with the step. A nonzero exit fails the
step unless `check: false`. Dry execution prints the command and substitutes
an empty successful result.

### Agent sessions

```ts
const session = await agents.session(reviewer);
const reply = await session.generate("Review the change.");
```

Use `{ cwd: checkout.root }` to select another host directory, or
`{ session: previousRef }` to continue a conversation.
[Agent sessions](/marbles/reference/agent-sessions) lists host and sandbox options.

A session's turns write to the step's stream and stop with the
step. `generate` returns the message with `text` (every text part of the
final turn), `output`, `usage`, and `result` (the AI SDK's result, absent
for Claude Code and Codex); `stream` returns the harness's stream, with
`output` and `partialOutputStream` beside `text` and `message`. `ref` is a
small serializable handle (`id`, and the `model` and `provider` it opened
with) for continuing the session later. Network-model sessions can use `compaction: true` to summarize older
history. Native CLI sessions manage compaction themselves and reject
explicit host compaction settings.

### Turn options

The second argument to `generate` and `stream` takes
`output` (an AI SDK `Output`), the AI SDK's model settings (`temperature`,
`maxOutputTokens`, `topP`, `topK`, `seed`, `stopSequences`, `stopWhen`,
`toolChoice`, `activeTools`, `reasoning`, `providerOptions`, …), `signal`,
and handlers such as `onText`. They override the agent's `settings`. A
turn whose `output` gets no matching value rejects with
`NoObjectGeneratedError` after the reply is committed. See
[structured output](/marbles/foundation/agents-and-sessions#structured-output).

### Workspace operations

```ts
const project = await workspaces.load({ path: "../website" });
await project.git.withWorktree(
  { base: "main", branch: "task/update" },
  async (checkout) => {
    // Use checkout.root for raw filesystem calls inside this callback.
  }
);
```

`workspaces.current` selects the current project. `load(definition)` or
`load({ path })` selects another one. A handle exposes `root`, `files`,
`entries`, `read`, `save`, `createFile`, `refresh`, `summary`, and `git`.

A handle is the [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md) workspace, loaded
at its first call: `files()` returns file entries (`id`, `path`,
`extension`, `kind`, size, and modification time), `entries()` adds
directories, `read(file.id)` returns the content, and `save` and
`createFile` write through the workspace's confinement checks. A handle
from `load` also has its registry `id` and `source`. Renaming or removing
a workspace belongs to the host. `current.git` throws when the root is not
a Git repository.

`withWorktree({ base, branch?, home? }, body)` creates a checkout
under the workspace's state, runs `body` with the working directory
narrowed to it, and removes it on return; a `branch` outlives the worktree.
`worktree(options)` creates one you must remove yourself, under the same home.
Naming a `branch` that exists fails before creating the checkout; check first
with `hasBranch(name)`, which reads the repository even under
`--dry-run`.

### Sandbox operations

```ts
const environment = await sandboxes.start(box);
const result = await environment.exec(["bun", "test"]);
```

`start(definitionOrSpec)` returns a handle; `open(id)` reopens one. The handle
provides `id`, `exec`, `commands`, `files`, `processes`, `shell`, `ports`,
`services`, `volumes`, and `close()`. Its `exec` returns an exit code even on
failure. Use the context's `exec(argv, { sandbox: box })` for automatic checking.

A handle is the [Sandbox](https://github.com/Francois-Esquire/foundry/blob/main/packages/sandbox/README.md) container. In a step
every command and process carries the step's signal, and `exec` writes
`$ <command>` and its output to the step's stream. `exec` takes an argv
array, run directly, or a string, run by the guest's shell, and the
package's options (`cwd`, `environment`, `user`). Listing, removing, and
restarting containers are the host's.

### Questions and approvals

```ts
const decision = await ask.approval({
  title: "Publish this revision?",
  body: findings,
});
const region = await ask.question({
  title: "Which region?",
  choices: ["us", "eu"],
});
```

`approval({ title, body?, key? })` returns `{ approved, note? }`.
`question({ title, body?, choices?, key? })` returns a string.

`approval` is a hard block: the run shows as blocked until someone
decides. `question` is input: the step waits, siblings keep going. Both
need a process that can show them; the dashboard parks the run, while
`roll` and headless `run` cancel it at the ask. `choices` gives a pick list
of at most nine; without it the answer is free text. Both are identified
by position in the body; `key` is optional, for updating one entry across
steps.

### Artifact operations

| Method | Result |
| --- | --- |
| `write(definition, files, { replace?, metadata? })` | A new version of a declared artifact. |
| `create({ name, type, entries, metadata?, freeze? })` | A one-off artifact and its first version. |
| `get(definitionOrId)` | The artifact record. |
| `listContents(definitionOrId)` | Its versions. |
| `getContent(versionId)` | One version. |
| `readFile(versionId, path)`, `readRoot(versionId)` | Stored file content or its tree. |

A version is the [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md) content record as
JSON: `id`, `artifactId`, `digest`, `state`, `tag`, `metadata`, `tree`,
and ISO timestamps. A version written in a step records the run and its
session in `metadata` (`runId`, `sessionId`). `write` replaces the files
unless `{ replace: false }`; a file is text, bytes, or the package's file
input (`{ bytes, mime }`, a stored `blobId`). Reads take the artifact's
declaration or its package id, and a version's `id`.

### Read across runs

`artifacts.latest(def)` (or `def.latest()`) is
the artifact's current version with `text(path)` and `bytes(path)`, or
`undefined` before the first write. A declared artifact belongs to the
workspace, so this is what the last run here kept. Under `--dry-run` it
reads what real runs kept while its own writes stay in memory. See the
[persistent reviewer](/marbles/use-cases/software-factory/development/verify#keep-review-history).

### Reports

```ts
report.milestone({ title: "Tests passed" });
report.result({ title: "Review", body: findings });
const version = await report.artifact(
  weeklyReport,
  { "report.md": findings },
  { body: findings }
);
```

`milestone` and `result` accept `{ title, body?, media?, key? }`.
`artifact(definition, files, entry?)` accepts optional entry settings.

Entries are fire-and-forget and land on the run and the feed.
`media` paths resolve from the workspace root and are copied into the
entry; refer to them in the body as `media/<file name>`. `report.artifact`
writes a version, posts a result entry titled after the artifact unless
`entry.title` says otherwise, and returns the version. The entry references
that exact version. Supply `entry.body` for readable Feed content; artifact
files are not automatically displayed by the Feed reader.

An artifact write by itself does not post to the Feed. Feed entries persist
too, using the artifact store internally. See
[Artifacts and the Feed](/marbles/foundation/artifacts-and-results#artifacts-and-the-feed)
for choosing between stored outputs, messages, and returned results.

### Output and cancellation

`log(...values)` logs at info level; `log.debug`, `.info`, `.warn`, and
`.error` select another level. `stream.write(value)` and `stream.pipe(source)`
write to the step's live output. Pass `signal` to operations you own:

```ts
await fetch(url, { signal });
```

Everything Marbles owns is already cancelled with the
step and already writes to the step's stream. `signal` and `stream` are for
the author's own work: a raw `fetch`, a child process, a line of output.

### Run information

`run` exposes `{ id, path, session, signal, stream, abort(reason) }`. Use
`run.id` to associate an artifact or log entry with this execution.

`run.abort(reason)` fails the whole run. `run.session` is the
run's own session; agents opened in the run are children of it.
`run.stream` is the whole run's output.

### Monitor observations

A monitor's handler extends the step context with `files` or `response`,
plus `change`; its `input` is empty. Narrow `change.kind` before accessing
source-specific data. `files` is `{ added, modified, removed }`, each a
`{ path, checksum }[]` with `path` relative to the workspace root; read
one with `node:fs` from `resolve(workspaces.current.root, path)`. `response`
is a standard `Response` over the polled body, with the original's
`status`, `statusText`, `url`, and `redirected`. `change` carries the diff:
the file lists, or `{ status, previous, current }` for HTTP, where a body
that is not text is `{ bytes, contentType }`.

## Triggers

```ts
schedule(weekly).at({ weekday: "fri", hour: 16, minute: 0 }); // machine-local time
schedule(review({}, { target: "packages" })).every("6h"); // "30s" | "10m" | "6h" | "1d"

monitor("docs/**/*.md").do(({ change, log }) => {
  if (change.kind === "files") log(change.modified);
});
monitor("https://status.example.com/api")
  .every("5m")
  .do(async ({ response, report }) => {
    if (!response) return;
    const { status } = await response.json();
    report.milestone({ title: `Status: ${status}` });
  });
monitor("https://tracker.example.com/latest")
  .every("10m")
  .do(async ({ response }) => {
    if (!response) return;
    return ship({}, { task: (await response.json()).title });
  });
```

- **`schedule(target)`** takes a named step or workflow, bare or as a
  childless lock. A lock carries its input, so there is no input field. A
  lock with children throws `wrap it in a named workflow first`; a
  nameless target throws `has no name`. `.at(slot)` or `.every(interval)` is
  the terminal call. `weekday` is `"sun"` through `"sat"` or an array; omit
  it for every day. `minute` defaults to zero. An interval is a positive
  integer with `s`, `m`, `h`, or `d`; `"0s"` is refused.
- **`monitor(source)`** takes one string. `http://` or `https://` is polled
  and fires when the response changes: each poll hashes the body, as stable
  JSON when it parses, as text for another textual type, as bytes
  otherwise, together with the status when it is not 2xx, and compares it
  with the last hash. A body that carries noise such as a timestamp fires
  every poll; read `response` and return early when nothing of interest
  changed. Anything else is a glob over the workspace root, polled; `files`
  lists what was added, modified, or removed since the last poll. `.every`
  defaults to one minute. `.do(fn)` is terminal.
- **`.request(init)`** is for an HTTP source only (a glob throws at load):
  a `RequestInit` without `signal`, or a function returning one, sync or
  async, called at every poll. It is never part of the key, the stored
  state, `list`, or the feed. A `401` or `403` fails the
  poll and logs the status and the URL, never what was sent; any other
  status is a reading, so a move to `404` or `500` is a change. A network
  error fails the poll and keeps the last state.
- **A handler that returns a locked node starts it**, attributed to the
  monitor: `ship({}, { task })` or `nightly({})`. Return a childless lock of a
  named definition. A bare definition is ignored; `undefined` launches
  nothing. At most one node starts per tick.
  The launch is held as pending until a tick has started it, so a crash in
  between hands it out again; a target no longer registered is dropped after
  one failed tick; a started run that fails or is cancelled is not started
  again.
- **The first poll has no baseline.** Every matching file is `added`, or the
  first body counts as a change, so the handler runs once on first start. A
  glob that matches nothing fires nothing.
- **Keys.** A schedule is keyed `slug(target)[-sha8(input)]`, a monitor
  `slug(source)-sha6(source)`; an exact duplicate gets `-2`. `list` prints
  the keys. They name the state files and `roll <key>`.

## Composition and durability

A step owns the input, output stream, cancellation, and managed operations
for its attempt. A worktree callback changes the working directory inherited
by new commands and sessions. Session options can select a different host
`cwd` or continue a recorded conversation.

| Situation | Rule |
| --- | --- |
| Continue the same run | Reuse completed step results. |
| Resume a parked step | Replay its unfinished body from the top. Recorded managed operations are matched by call order. |
| Retry a failed attempt | Apply that step's policy with fresh managed operations; completed children keep their results. |
| Launch again | Create a new run and execute fresh work. |
| Restart the host | Adopt eligible parked runs. Interrupted queued or running work is not adopted. |
| Rebuild workflow setup | Recreate the tree; recovered nodes retain their recorded literal input. |

Keep managed call order stable. Branch on recorded input when it controls
those calls; branching on live values can change their replay positions.
An explicit session turn can execute again during replay. A one-shot agent
call can reuse its completed reply. Put an approval at the start of its
step, with non-repeatable work in a completed child or after the answer.

The CLI saves snapshots at suspension, resumption, and settlement. Newer
progress may not reach disk before a crash. The [durability guide](/marbles/foundation/durability)
describes each operation; [state](/marbles/reference/state#what-survives-a-restart)
lists adoption conditions.

Pausing or cancelling signals owned operations. Custom work must honor
`signal`; a step cannot settle until its attempt stops. The dashboard
supports [steering, pause, and resume](/marbles/reference/cli#pause-resume-and-steer)
without authored control code.

## Exports

The main entry exports the factories above, the AI SDK's `Output`, `bail`,
`defineSkill`, `dispose`, and `usage`, the shared instance of
[`@foundry/usage`](https://github.com/Francois-Esquire/foundry/blob/main/packages/usage/README.md).
Marbles adds the default accounts, `anthropic` and `openai`, before any step
runs; a failure to add them is printed and does not stop the run. It also
exports these types:

| Group | Types |
| --- | --- |
| Instances | `Agent`, `Runnable`, `WorkspaceInstance`, `SandboxInstance`, `ArtifactInstance` |
| Work | `StepDefinition`, `WorkflowDefinition`, `LockedNode` |
| Resource definitions | `AgentDefinition`, `AgentSettings`, `WorkspaceDefinition`, `SandboxDefinition`, `SandboxSpec`, `ArtifactDefinition`, `SkillSet` |
| Agents | `Agents`, `Session`, `SessionRef`, `SessionReply`, `TurnOptions` |
| Workspaces and sandboxes | `Workspaces`, `WorkspaceHandle`, `LoadedWorkspace`, `Sandboxes`, `SandboxHandle` |
| Artifacts | `Artifacts`, `ArtifactVersion` |
| Execution | `Context`, `Ask`, `Approval`, `Report`, `Stream`, `Run`, `Log`, `LogLevel` |
| Triggers | `Schedule`, `ScheduleBuilder`, `MonitorBuilder`, `CalendarSlot`, `Weekday`, `Trigger`, `MonitorContext`, `MonitorHandler`, `Change`, `FileChange`, `HttpChange` |
| Usage | `Snapshot`, `Identity`, `Limit`, `Window`, `SpendCap`, `Balance`, `CreditBalance`, `Headroom`, `Money`, `Credits`, `Duration`, `Span`, `Consumption`, `SessionConsumption`, `Quantities`, `Charge`, `QueryOptions`, `QueryAllOptions`, `DurationText` |

`@foundry.sh/marbles/prebuilt` exports the
[prebuilt step factories](/marbles/reference/project#prebuilt-steps).

## Not available yet

Do not write modules that depend on these.

- Race, branch, and loops between steps. Only series and parallel.
- A built-in model provider. No `provider` means the first installed CLI.
- Recovery of a step that was mid-body when the process stopped. A step
  parked on an `ask` or a pause does survive a quit, a crash, or a kill.
- Scheduling a tree with children without wrapping it in `workflow`.
- Remote deployment commands, a remote dashboard, or distributed workers.

See [Installation](/marbles/get-started/installation) for package availability.
