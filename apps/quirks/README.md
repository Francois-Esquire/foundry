# Quirks

**Quirks turns recurring behaviors into inspectable TypeScript.**

Composable local automation, with agents where judgment is useful. Define what
should happen, what should be watched, when it should run, and where an agent
may participate. Run it once, keep it active in a terminal, or let launchd invoke
it on a schedule.

Nine words compose ordinary code, model turns, and retained conversations:
`step`, `workflow`, `agent`, `workspace`, `sandbox`, `artifact`, `skills`,
`schedule`, and `monitor`.

## Start small

`@foundry/quirks` is not on npm yet. It requires Bun 1.3.14 or newer and runs
from this repository:

```sh
bun run quirks -- --help                 # from the repository root
cd apps/quirks && bun run build          # then, from anywhere:
bun /path/to/foundry/apps/quirks/dist/cli.js --config ./quirks.config.ts list
```

Create `quirks.config.ts`:

```ts
import { readdir } from "node:fs/promises";
import { schedule, step } from "@foundry/quirks";

const countFiles = step("count-files").do(async ({ workspaces, log }) => {
  const entries = await readdir(workspaces.current.root, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).length;
  log(`${files} files at the workspace root`);
  return { files };
});

schedule(countFiles).every("1h");
```

```sh
quirks once count-files
quirks                 # same as quirks run
quirks status
```

In a terminal, `quirks` and `quirks run` open the splash, load your
configuration and saved run history, then wait for Enter or a click. Enter opens
the Triggers, Catalog, and Runs dashboard and starts schedules and monitors.
A missing config opens a guided setup for Developer/code review, Design/prototype,
or Product/codebase summary. It creates only your selected prebuilt step.
A valid empty configuration opens the dashboard directly; nothing registers by
default. `quirks --help` prints usage. Piped or redirected runs use plain text
and start immediately.

Press `q` or Ctrl+C to open the quit dialog; Ctrl+C again confirms. Quitting
stops triggers and cancels queued and running runs. A run parked on a question
or a pause is kept, with its question open, and is picked up by the next
dashboard that starts with the same state root. Custom steps receive `signal`
in their context and should pass it to work Quirks does not own, such as
`fetch`. Cancellation does not undo side effects.

Deterministic steps need no agent harness. For model operations, install and
authenticate Claude Code or Codex. The CLI resolves configuration imports of
`@foundry/quirks` and `@foundry/quirks/prebuilt` to its own installation; a
schema library such as `zod` must resolve from the config's directory.

State is saved to disk between invocations. `--dry` echoes agent turns, git
mutations, and sandbox commands instead of running them and writes no state;
it does not contain custom code, monitor I/O, or launchd installation and
removal. Working directories are execution context, not security sandboxes.

## Start with a prebuilt step

```ts
import { summarizeCodebase } from "@foundry/quirks/prebuilt";
summarizeCodebase();
```

Press `2` for Catalog, Enter for details, then `l` or click Launch. A step with
an `.input(schema)` opens a form derived from the schema; one without launches
immediately. The dashboard selects the new run while triggers continue running.

## Coding inside MicroSandbox

A sandbox session prepares the Linux CLI before its first turn. MicroSandbox
consumes the base image directly. Claude Code uses the host subscription login;
only the current access token enters the guest process. Host login directories
and refresh credentials remain on the host. An explicit `oauthToken` from
`claude setup-token` can select a different subscription credential.

```ts
import { agent, step } from "@foundry/quirks";

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

The usual tool approval policy governs these operations. Quirks stores durable
trigger definitions under workspace state and executes them through its existing
schedule loop. Calendar times use the host's local timezone. Creation time
anchors the first firing across restarts. Resuming an overdue trigger fires it
once, without queueing missed intervals. File globs stay relative to the
configured workspace. HTTP monitors may use origins already
selected by configured HTTP monitors. Redirects are refused. Invalid recovered records remain disabled and display diagnostics.

Managed triggers show their owner and durable lifetime. Select one and press
`p` to pause/resume or `k` to delete it. These actions affect future firings;
an already running workflow retains its own controls. Native CLI schedules
remain owned by that CLI and are not silently copied into Quirks. Monitor
startup failures retain pending delivery for retry; a crash between launch and
acknowledgement can redeliver, so target workflows should tolerate duplicates.

Embedding hosts pass `getSchedules: () => engine.schedules()` to
`runSchedules` for live additions/removals. Durable execution requires a running
Quirks loop or an installed host schedule. Pi integration is deferred.

## Embedding the engine

The CLI is one host of an engine any Bun program can run. `@foundry/quirks` is
unchanged: the words a config writes definitions with. `@foundry/quirks/lib`
holds the `Engine` that runs them.

The engine is handed five instances, one from each Foundry package, each
already configured for the machine it runs on. It builds everything that
connects them: the managers a step body sees, the feed, agent approvals and
activity, the triggers agents create, and the run queue.

```ts
import { step } from "@foundry/quirks";
import {
  ArtifactSystem,
  Engine,
  InMemoryArtifactStore,
  InMemorySessionStore,
  ModelManager,
  WorkspaceSystem,
  directory,
  git,
  nodeObserver,
} from "@foundry/quirks/lib";

const engine = new Engine({
  models: new ModelManager({ providers: [/* yours */] }),
  sessions: new InMemorySessionStore(),
  workspaces: new WorkspaceSystem().extend(
    directory({ observer: nodeObserver }),
    git()
  ),
  // Called at the first sandbox; `createContainers` over your runtime.
  containers: () => Promise.reject(new Error("no sandbox runtime here")),
  artifacts: new ArtifactSystem({ store: new InMemoryArtifactStore() }),
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

All five instances are required. The engine hands them back (`engine.models`,
`engine.sessions`, `engine.workspaces.catalogue`) and closes them in
`dispose()`.

The engine keeps its own registry and is told what can run:

- `engine.define(definition)` adds a named step or workflow. The authoring
  words return exactly that, so `engine.define(step("x").do(...))` works.
- `engine.schedule(record)` starts a definition on a cadence, and
  `engine.monitor(key, source, record)` watches a source.
- `engine.definitions()`, `engine.schedules()`, and `engine.monitors()` read
  it back, including the triggers agents created.

Importing a `quirks.config.ts` does not fill an engine you built. The config's
own collection is private to the CLI, which copies it into the engine it
builds. A host that wants a config's definitions exports them from the config
and defines them.

A few optional settings cover what the five instances cannot say: `print`
receives engine status and body `log(...)` lines, `home` is where shared
skills are read from, `git` is how git runs on the root workspace when the
`git()` layer was built with a custom runner, and `dry` makes agents asked
for a sandbox run in-process instead.

The package bundles its Foundry packages, so take the base classes
(`ModelManager`, `InMemorySessionStore`, `WorkspaceSystem`, `ArtifactSystem`,
`createContainers`, and the rest) from `@foundry/quirks/lib` as well. An
instance built from another copy of the same class is a different type.

## Documentation

- [Introduction](https://francois-esquire.github.io/foundry/quirks/)
- [Start Here](https://francois-esquire.github.io/foundry/quirks/start-here/)
- [Concepts](https://francois-esquire.github.io/foundry/quirks/concepts/)
- [Use Cases](https://francois-esquire.github.io/foundry/quirks/use-cases/)
- [API reference](https://francois-esquire.github.io/foundry/quirks/reference/api/)
- [CLI reference](https://francois-esquire.github.io/foundry/quirks/reference/cli/)
- [Safety and Limits](https://francois-esquire.github.io/foundry/quirks/safety-and-limits/)
- [Contributing](https://francois-esquire.github.io/foundry/quirks/contributing/)

Repository setup and documentation development commands are in the contributing guide.

## Terminal UI development

Run `bun run preview:ui` from this directory to open the interactive dashboard
snapshot. See the [preview guide](preview/README.md) for the component structure,
keyboard controls, and sample data. The live CLI uses the same components through
`src/dashboard`, which adapts runtime records into presentation snapshots.
From this directory, `bun run start` or `bun run start -- run` opens the live app.
