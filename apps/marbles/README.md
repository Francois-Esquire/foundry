# Marbles

**Marbles turns recurring automations into inspectable TypeScript.**

Composable local automation, with agents where judgment is useful. Define what
should happen, what should be watched, when it should run, and where an agent
may participate. Run it once, keep it active in a terminal, or let launchd invoke
it on a schedule.

Nine words compose ordinary code, model turns, and retained conversations:
`step`, `workflow`, `agent`, `workspace`, `sandbox`, `artifact`, `skills`,
`schedule`, and `monitor`.

## Start small

`@foundry/marbles` is not on npm yet. It requires Bun 1.3.14 or newer and runs
from this repository:

```sh
bun run marbles -- --help                 # from the repository root
cd apps/marbles && bun run build          # then, from anywhere:
bun /path/to/foundry/apps/marbles/dist/cli.js list
```

Create `.foundry/marbles/inspect.ts`:

```ts
import { readdir } from "node:fs/promises";
import { schedule, step } from "@foundry/marbles";

const countFiles = step("count-files").do(async ({ workspaces, log }) => {
  const entries = await readdir(workspaces.current.root, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).length;
  log(`${files} files at the workspace root`);
  return { files };
});

schedule(countFiles).every("1h");
```

```sh
marbles roll count-files
marbles                 # same as marbles run
marbles status
```

In a terminal, `marbles` and `marbles run` open the splash, load your
authoring modules and saved run history, then wait for Enter or a click. Enter opens
the Triggers, Marbles, and Runs dashboard and starts schedules and monitors.
A missing authoring folder opens a guided setup for Developer/code review, Design/prototype,
or Product/codebase summary. It creates only your selected prebuilt step.
An existing empty authoring folder opens the dashboard directly; nothing registers by
default. `marbles --help` prints usage. A command line Marbles cannot run (an
unknown command or `--harness` id, or the wrong arguments) prints the problem
and the usage to stderr and exits 1 before any module loads. Piped or
redirected runs use plain text and start immediately.

Press `q` or Ctrl+C to open the quit dialog; Ctrl+C again confirms. Quitting
stops triggers and cancels queued and running runs. A run parked on a question
or a pause is kept, with its question open, and is picked up by the next
dashboard that starts with the same state root. Custom steps receive `signal`
in their context and should pass it to work Marbles does not own, such as
`fetch`. Cancellation does not undo side effects.

Deterministic steps need no agent harness. For model operations, install and
authenticate Claude Code or Codex. Marbles uses the first one it finds, Claude
Code first; `--harness codex` (or `claude-code`, repeatable) keeps only the
ones named. The CLI resolves authoring imports of
`@foundry/marbles` and `@foundry/marbles/prebuilt` to its own installation; a
schema library such as `zod` must resolve relative to the importing file.

State is saved to disk between invocations, under
`~/.foundry/marbles/<workspace-id>/`: runs, schedule history, sessions, grants,
and the triggers agents create. `status` and `sessions` read it without
loading your modules. `--dry-run` echoes agent turns, git mutations, and
sandbox commands instead of running them and writes no state; it does not
contain custom code or monitor I/O. Under `--dry-run`, `launchd` prints the
plist and launchctl commands instead of running them. Working directories are
execution context, not security sandboxes.

A tick or a session write takes a lock file that names its process. The lock of
a process that has exited is taken over, one process at a time, through a
short-lived `<lock>.break` file. If a crash leaves a `.break` behind, delete it
and takeover resumes. See the
[state reference](https://francois-esquire.github.io/foundry/marbles/reference/state/).

## Authoring folder

Run `marbles init` from your project root to create
`.foundry/marbles/summarize-codebase.ts`. Choose `init developer` for code
review or `init design` for a prototype. Setup creates directories and one
starter module, refuses to overwrite it, and runs no step body.

Marbles recursively imports JavaScript and TypeScript modules from
`.foundry/marbles` in sorted path order. Files and directories beginning
with `_` are excluded from discovery, so `_shared/`, `_apps/`, and `_test/`
can hold ordinary code. They remain importable. Hidden entries, declaration
files, `node_modules`, and symlink entries are skipped too.

The workspace is the project above `.foundry`, so moving authoring code
into this folder does not move agent sessions or relative workspace paths.
`--source` selects a different folder or single module. Custom folders use
themselves as the workspace; standalone files use their containing folder.
`--config` remains an alias, and a legacy `marbles.config.ts` loads when the
default folder is absent. Restart after editing modules.

## Start with a prebuilt step

```ts
import { summarizeCodebase } from "@foundry/marbles/prebuilt";
summarizeCodebase();
```

Press `2` for Marbles, Enter for details, then `l` or click Launch. A step with
an `.input(schema)` opens a form derived from the schema; one without launches
immediately. The dashboard selects the new run while triggers continue running.

## Coding inside MicroSandbox

A sandbox session prepares the Linux CLI before its first turn. MicroSandbox
consumes the base image directly. Claude Code uses the host subscription login;
only the current access token enters the guest process. Host login directories
and refresh credentials remain on the host. An explicit `oauthToken` from
`claude setup-token` can select a different subscription credential.

```ts
import { agent, step } from "@foundry/marbles";

const coder = agent({
  provider: "claude-code",
  model: "sonnet",
  prompt: "Make focused fixes in /workspace and verify them with bun test.",
});

step("fix-fixture").do(async ({ agents, sandboxes }) => {
  const box = await sandboxes.start({
    image: "docker.io/oven/bun:1-slim",
    executable: true,
    network: {
      mode: "allowlist",
      destinations: [{ host: "api.anthropic.com", ports: [443] }],
    },
  });
  const session = await agents.session(coder, {
    sandbox: box,
    profile: {
      mode: "scheduled",
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(bun test:*)"],
      disallowedTools: [],
      unresolved: "deny",
      maxSteps: 20,
    },
  });
  return (await session.generate("Fix the failing test without changing the test.")).text;
});
```

Network access defaults to disabled, and executable workspace mounts are opt-in.
Native session history currently resumes only while the same guest remains
alive; reopening against a replacement guest fails explicitly. Scheduled
approval requests are recorded and denied for that invocation.

For interactive work in the dashboard, use `mode: "attended"` and
`unresolved: "ask"`. Tool approvals appear in the Feed. Choose approval for
one invocation, a grant for the current session, or denial with an optional
reason. The run and step show "Waiting for approval" while the same agent
turn remains alive. Pause, steer and cancel remain available.

Model questions appear in the same Feed with "Waiting for answer" on the run.
Claude's native `AskUserQuestion` and the shared `ask_user` tool return the
person's actual answers. Codex uses `ask_user` in ordinary coding mode; its
native app-server question requests use the same callback. A declined question
is never treated as a permission grant or an invented answer. Multiple-choice
questions accept a listed choice or a custom answer; multiple selections use
semicolon-separated text.

Scheduled runs never wait for someone. Refused permission requests appear as
"Future permission" entries. Approving one persists a tool grant for that agent
in the workspace, so a later run can proceed; it does not replay the refused
action. Deferred entries and grants survive a host restart. Live unanswered
requests are cancelled when their turn stops. Model questions in unattended
runs produce a feed notice and return an explicit decline.

Grants and the triggers an agent creates are filed under the agent's id, so
the id must stay the same when the module around it changes. It is
`agent({ name })` when given, else the top-level `const` the call is assigned
to, else `agent-` and a digest of its prompt, provider, and model. Two
different agents with one id fail at import; rename one or name it. A
trigger also belongs to the session that created it: `list_automations`
shows only the calling session's own.

The CLI/dashboard bind this automatically. An embedding host gets the same
from the `Engine`, which builds the interactions over the artifact system and
session store it is handed; `askable` says whether someone can answer. A host
can override `authority` or `question` on a session.
Custom callbacks must remain abortable and must not call the workflow `ask`
suspension API. Custom authority stores retain responsibility for their own
restart recovery; the default runtime persists its grants locally.

Embedding hosts register network providers on the `ModelManager` they hand the
engine.
These use the built-in coding loop with scoped guest tools, a step limit, and
compaction. The existing OpenAI-compatible gateway provider also supports
OpenRouter configuration. Legacy sessions without `sandbox` retain their prior
execution path; new profiles and credential options require a sandbox.

The standalone bundle includes the OpenAI-compatible SDK dependencies used by
the built-in path; their narrow Knip exceptions reflect bundled workspace imports.

## Child agents and automation

Sandbox sessions expose a `delegate` tool that opens a child session with the
same harness, model, MicroSandbox, and permission profile. It waits for the
child's result. Each open parent session permits eight launches, two active
children across its delegation tree, and at most three nested levels. Child
questions and approvals remain live feed requests. Cancelling the parent
cancels its children; selecting a child and pressing `k` stops only that child
when its adapter advertises the control.

The run tree also shows native Claude and Codex subagents and background
activity. Native activity is separate from workflow steps. Its details show
its harness, owning session, state, lifetime, and a redacted summary. Missing
contact displays `unknown`, never an inferred successful completion. Activity
history is recorded in agent sessions; workspace projections retain dashboard
visibility after restart. Reopened projections have no live controls until a
host attaches the corresponding session.

Codex keeps one app-server connection per session and observes subscribed
children between parent turns. A child with a known active native turn can be
stopped without interrupting its parent. Claude exposes task stopping while its
query is active, plus observed Monitor and Cron activity. Its current provider transport
closes after the parent result, so detached Claude activity is not continuously
observed. Claude native `AskUserQuestion` carries child attribution. The
provider's generic MCP bridge does not expose enough correlation to attribute
an arbitrary native child's shared `ask_user` call reliably.

Every sandbox harness receives these authorized host tools:

- `list_automation_targets` lists registered workflows and input schemas.
- `create_automation` accepts a session-local idempotency `key`, `workflow`,
  `input`, and `at`, such as `"1h"` or `{ "hour": 9, "minute": 30 }`.
- Adding `source: { "kind": "files", "glob": "src/**/*.ts" }` or
  `{ "kind": "http", "url": "https://example.com/status" }` creates a change
  monitor at that cadence.
- `list_automations`, `set_automation_enabled`, and `delete_automation` manage
  the calling agent session's records. Delegated children own their own records.

Repeating a creation key returns its existing record. After deletion, reusing
that key creates a fresh automation ID and execution history. An older firing
can finish independently without delivering its pending work to the new trigger.

The usual tool approval policy governs these operations. Marbles stores durable
trigger definitions under workspace state and executes them through its existing
schedule loop. Calendar times use the host's local timezone. Creation time
anchors the first firing across restarts. Resuming an overdue trigger fires it
once, without queueing missed intervals. File globs stay relative to the
configured workspace. HTTP monitors may use origins already
selected by configured HTTP monitors. Redirects are refused. Invalid recovered records remain disabled and display diagnostics.

Managed triggers show their owner and durable lifetime. Select one and press
`p` to pause/resume or `k` to delete it. These actions affect future firings;
an already running workflow retains its own controls. Native CLI schedules
remain owned by that CLI and are not silently copied into Marbles. Monitor
startup failures retain pending delivery for retry; a crash between launch and
acknowledgement can redeliver, so target workflows should tolerate duplicates.

Durable execution requires a running Marbles loop or an installed host
schedule. Pi integration is deferred.

Host sessions accept `cwd`; sandbox sessions select their workspace through
mounts and accept permission profiles, question handlers, and credentials.
These option sets are distinct in TypeScript. Network-model sessions accept
`compaction: true` or custom settings, and `false` disables compaction.
Compaction defaults off on the host and on for the built-in sandbox coding
harness. Native CLI sessions manage their own compaction and reject host
compaction settings. Both `generate` and `stream` follow steering prompts;
a steered stream emits one final finish event, and its final promises describe
the last turn.

## Embedding the engine

The CLI is one host of an engine any Bun program can run. `@foundry/marbles` is
unchanged: the words a module writes definitions with. `@foundry/marbles/lib`
holds the `Engine` that runs them. A program builds one from explicit
instances, then drives and inspects it without the CLI, the dashboard, or the
authoring words.

The engine is handed an instance from each Foundry package, each already
configured for the machine it runs on. It builds everything that
connects them: the managers a step body sees, the feed, agent approvals and
activity, the triggers agents create, and the run queue.

```ts
import { step } from "@foundry/marbles";
import {
  ArtifactManager,
  Engine,
  InMemoryArtifactStore,
  InMemorySessionStore,
  ModelManager,
} from "@foundry/marbles/lib";

const engine = new Engine({
  models: new ModelManager({ providers: [/* yours */] }),
  sessions: new InMemorySessionStore(),
  // Called at the first sandbox; `createContainers` over your runtime.
  containers: () => Promise.reject(new Error("no sandbox runtime here")),
  artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
  root: process.cwd(),
  workspaceId: "my-app",
  state: "/path/to/state", // omit and nothing survives the process
  askable: false, // true when something in this process can answer `ask`
});

engine.define(
  step("inventory").do(async ({ workspaces }) => workspaces.current.files())
);

await engine.start();
const files = await engine.run<string[]>("inventory", {});
await engine.stop();
await engine.dispose();
```

`models`, `sessions`, `containers`, and `artifacts` are required. `workspaces`
is optional: without it the engine builds a workspace system over the local
filesystem, watched, whose `git()` layer runs git as the `git` option says. A
host that brings its own `WorkspaceSystem` builds its `git()` layer with the
same options it passes as `git`. The engine hands the instances back
(`engine.models`, `engine.sessions`, `engine.workspaces.system`,
`engine.sandboxes.containers()`) and closes them in `dispose()`.
`engine.store` is the state store it keeps trigger state in, and
`engine.scopes` is a read-only view of the runs in flight: each run's
`RunScope` by run id.

The managers a step body gets as `agents`, `workspaces`, `sandboxes`, and
`artifacts` are on the engine too, with the same methods, and work without a
run and before `start()`:

```ts
import { agent, artifact } from "@foundry/marbles";

const reviewer = agent({ prompt: "Review the diff." });
const report = artifact({ name: "review", type: "text/markdown" });

const repo = await engine.workspaces.load({ path: "/path/to/repo" });
const session = await engine.agents.session(reviewer, { cwd: repo.root });
const reply = await session.generate("Review this.");
const box = await engine.sandboxes.start({ image: "oven/bun:1-slim" });
const version = await engine.artifacts.write(report, { "report.md": reply.text });
```

Inside a step these calls are tied to the step: they replay to the same
session, sandbox, or version, stop when the step is cancelled, and close when
the run settles. On the engine there is no step, so each call is new, a
sandbox is yours to close, and whatever is still open closes on `dispose()`.
`engine.sandboxes.containerOf(box)` returns the container behind a sandbox
the engine opened.

The engine keeps its own registry and is told what can run:

- `engine.define(definition)` adds a named step or workflow. The authoring
  words return exactly that, so `engine.define(step("x").do(...))` works.
- `engine.schedule(record)` starts a definition on a cadence.
- `engine.monitor({ key, source, trigger, handler })` watches a glob or a URL
  and calls the handler when it changes.
- `engine.definitions()`, `engine.schedules()`, and `engine.monitors()` read
  it back, including the triggers agents created.

Importing a `.foundry/marbles/inspect.ts` does not fill an engine you built. The module's
own collection is private to the CLI, which copies it into the engine it
builds. A host that wants a module's definitions exports them from the module
and defines them.

A few optional settings cover what the instances cannot say: `print`
receives engine status and body `log(...)` lines, `home` is where shared
skills are read from, `git` is how git runs (for example a runner that echoes
instead), `worktrees` is where worktrees are cut when a step names no `home`
(`Engine.worktreesFor(state)` by default), and `dry` makes agents asked for a
sandbox run in-process instead. `store` is the `StateStore` that keeps
schedule history, monitor observations, and the triggers agents create, with
the locks that keep two ticks apart. It defaults to a `JsonStateStore` over
`state`, or an `InMemoryStateStore` without one; both are exported.

The package bundles its Foundry packages, so take the classes the
instances are built from out of `@foundry/marbles/lib` as well. An instance
built from another copy of the same class is a different type. Besides
`Engine`, its types, and three constants (`CLI_HARNESS_IDS`, `CLI_HARNESSES`,
`TERMINAL_RUN_STATUSES`), the entry exports only those:

| Instance | Exports |
| --- | --- |
| `models` | `ModelManager`, `claudeCodeProvider`, `codexProvider` |
| `sessions` | `InMemorySessionStore`, `JsonSessionStore` |
| `workspaces` | `WorkspaceSystem`, `directory`, `git`, `nodeObserver` |
| `containers` | `createContainers`, `createMemoryContainerStore` |
| `artifacts` | `ArtifactManager`, `InMemoryArtifactStore`, `JsonArtifactStore`, `blobFiles` |
| `store` | `JsonStateStore`, `InMemoryStateStore` |

Two things a host cannot do through this entry yet: the MicroSandbox runtime
`createContainers` needs is not exported, and nothing fires the triggers the
engine holds (the CLI's schedule loop is not part of the engine).

## Documentation

- [Introduction](https://francois-esquire.github.io/foundry/marbles/)
- [Start Here](https://francois-esquire.github.io/foundry/marbles/start-here/)
- [Concepts](https://francois-esquire.github.io/foundry/marbles/concepts/)
- [Use Cases](https://francois-esquire.github.io/foundry/marbles/use-cases/)
- [API reference](https://francois-esquire.github.io/foundry/marbles/reference/api/)
- [CLI reference](https://francois-esquire.github.io/foundry/marbles/reference/cli/)
- [Safety and Limits](https://francois-esquire.github.io/foundry/marbles/safety-and-limits/)
- [Contributing](https://francois-esquire.github.io/foundry/marbles/contributing/)

Repository setup and documentation development commands are in the contributing guide.

## Terminal UI development

Run `bun run preview:ui` from this directory to open the interactive dashboard
snapshot. See the [preview guide](preview/README.md) for the component structure,
keyboard controls, and sample data. The live CLI uses the same components through
`src/dashboard`, which adapts runtime records into presentation snapshots.
From this directory, `bun run start` or `bun run start -- run` opens the live app.
