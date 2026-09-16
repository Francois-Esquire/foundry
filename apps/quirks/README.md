# Quirks

Workflows for coding agents, as code. A `quirks.config.ts` declares steps,
workflows, agents, schedules and monitors with five factories; the `quirks` CLI runs
them against the Claude Code and Codex harnesses on your machine.

## Concepts

| Term          | What it is                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------- |
| **Step**      | One unit of work: `(primitives, input) => output`. Plain code with the Foundry libraries in hand. |
| **Workflow**  | A graph of steps. Maps earlier outputs to later inputs; `sequence`, `parallel`, `race`, `branch`. |
| **Monitor**   | A schedule that polls files or a URL and runs its handler only when something changed.            |
| **Agent**     | A retained prompt and model. Opened as a session from inside a step.                              |
| **Session**   | An agent's conversation, keyed by id. Persists per workspace.                                     |
| **Schedule**  | A workflow, its input, and a cadence. Its last tick and next due are recorded.                    |
| **Run**       | One dispatch of a workflow. Written to disk once it settles, hydrated on the next start.          |
| **Workspace** | The directory a config lives in. All state is scoped to it; one machine can run many.             |
| **Harness**   | A coding-agent CLI on this machine: `claude-code` or `codex`. Each model turn runs inside one.    |

**Two phases.** Importing the config _registers_: every `step()`, `workflow()`,
`agent()` and `schedule()` call writes into one registry and returns a handle.
Then the CLI _binds_ primitives, once it knows whether this is a `--dry` run and
which harnesses exist. A step body receives those primitives at run time, which
is why the same config can be listed, dry-run and run for real without changes.

**Thin by design.** Quirks does not wrap the libraries. A step body talks to
`ModelManager`, `SessionHarness` and `WorkspaceSystem` directly, so anything
those packages can do, a config can do. One-shot model turns are a single
`generateText` call against a harness model; the harness runs its own agentic
loop.

## Quick start

Build once from the repository root (`bun run build`), then put a
`quirks.config.ts` in the directory you run from. The config is a module
with side effects, not a schema: importing it runs the factory calls, and
that is what registers everything. Quirks requires Bun 1.3.14 or newer. It is a private workspace app.
Run the commands below from the Foundry repository root after building.
For another workspace, invoke `bun /path/to/foundry/apps/quirks/dist/cli.js`
from that directory and import its matching built library in the config.

```ts
import { schedule, step } from "@foundry/quirks";

const count = step("count-files", async ({ workspaces, log }, root: string) => {
  const ws = await workspaces.system.add({ path: root });
  const { files } = await ws.refresh();
  log(`${String(files.length)} files under ${root}`);
  return { files: files.length };
});

schedule("count-hourly", { workflow: count, input: ".", at: "1h" });
```

```sh
bun run quirks list                             # what is registered, when each is due
bun run quirks once count-files --input '"."'   # run one now, print its output
bun run quirks run --dry                        # every schedule, model turns echoed
bun run quirks run                              # for real; Ctrl-C stops
```

The lib and the CLI must be one install: a config that imports
`@foundry/quirks` from one copy while a `quirks` bin runs from another
registers into a registry the bin never reads, and `list` shows nothing.
Keep the config and command pointed at the same build.

## Commands

| Command                        | What it does                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| `run`                          | Run every schedule until stopped. A tick due mid-run is skipped.  |
| `once <name> [--input json]`   | Dispatch one workflow or schedule now, print its result, exit.    |
| `list`                         | Workflows, schedules and cadence.                                 |
| `status`                       | Every workspace on this machine: loop, schedules, runs, sessions. |
| `sessions`                     | Agent sessions in this workspace: id, messages, updated, summary. |
| `launchd install <schedule>`   | Write a LaunchAgent plist that runs `once <schedule>` on cadence. |
| `launchd uninstall <schedule>` | Remove it.                                                        |

| Flag              | Default               | Meaning                                             |
| ----------------- | --------------------- | --------------------------------------------------- |
| `--config <path>` | `./quirks.config.ts` | Config module. Optional: built-ins run without one. |
| `--state <dir>`   | `~/.foundry/quirks`  | State root. See State below.                        |
| `--dry`           | off                   | Echo every model turn and git mutation; no state.   |
| `--harness <id>`  | all detected          | `claude-code` or `codex`. Repeatable.               |

`once <schedule>` takes a per-schedule lock, so a tick that lands while the
previous one is still running prints `skipped` and exits 0.

## State

Every command is a fresh process. It hydrates from the state root, does its
work, writes back, and exits. That is what lets launchd drive schedules with
no resident daemon, and what `quirks run` does in a loop.

State is scoped to the **workspace**: the directory the config lives in. Its
id is a hash of the real path, so the state root's subdirectories are the
registry of every workspace this machine has run.

```
~/.foundry/quirks/<id>/
  workspace.json          root, config, firstSeen, lastSeen
  runs/<runId>.json       one file per run: pid, run, jobs, frames
  schedules/<name>.json   lastStart, lastFinish, lastStatus, nextDue
  monitors/<name>.json    what the monitor saw last tick, to diff against
  locks/<schedule>        pid of the tick running it
  heartbeat.json          pid of a foreground `run` loop, while it lives
  sessions/<id>.json      agent conversations
```

Quirks's own files (workspace, runs, schedules, monitors, heartbeat) carry
`version: 1`; a session file is the `@foundry/agents` session shape as-is.
`quirks status` reads all of it and
needs no Quirks running. A run whose pid is gone before it settled shows as
orphaned. In a terminal, status opens an OpenTUI view; press `q` or Ctrl+C
to close it. Piped output is plain text.

`--dry` disables Quirks state writes and substitutes echo model/git operations.
Config imports and custom step bodies still execute, so their own side effects
are not sandboxed.

### Install as a launchd agent

launchd owns the clock; Quirks owns nothing between ticks.

1. From the Foundry repository root, build: `bun run build`.
2. From the Foundry repository root, turn one schedule on:
   `bun run quirks launchd install <schedule>`. It writes
   `~/Library/LaunchAgents/com.foundry.quirks.<schedule>.plist` with an
   explicit `PATH`, the absolute config path, logs under
   `~/Library/Logs/quirks`, and loads it with `launchctl bootstrap`. The
   plist runs whichever runtime ran `install`, so install with the one you
   want ticking. Reinstall after a config change; it reloads.
3. Check it fired: `bun run quirks status`, or the log files.
4. Turn it off: `bun run quirks launchd uninstall <schedule>`. It unloads,
   then removes the plist.

If `launchctl` fails, the command to run by hand is printed. macOS only; a ws
monitor is refused, since it needs `quirks run`. Intervals count from when
the agent loads, not from a wall-clock time.

## Library

Everything a config needs comes from one import:

```ts
import { agent, monitor, schedule, step, workflow } from "@foundry/quirks";
```

### `step(name, body)`

`body(primitives, input)` returns the step's output. Output must be JSON
serializable. The handle is a real `@foundry/workflows` `Step`, so it slots
into any graph.

```ts
const hello = step("hello", async ({ log }, who: string) => {
  log(`hello ${who}`);
  return { greeted: who };
});
```

### `Primitives`

What every step body receives first.

| Field                        | Type                      | Use                                                       |
| ---------------------------- | ------------------------- | --------------------------------------------------------- |
| `models`                     | `ModelManager`            | `models.model(model, provider, { workingDirectory })`     |
| `executors`                  | `TurnExecutorRef[]`       | Harnesses on this machine, preferred first. Never empty.  |
| `workspaces.system`          | `WorkspaceSystem`         | Catalogue a directory, list files with checksums, git.    |
| `workspaces.git(root)`       | `Git`                     | Status and throwaway worktrees; echoed under `--dry`.     |
| `workspace.root`             | `string`                  | The config's directory; skills load from `<root>/skills`. |
| `state`                      | `string \| undefined`     | This workspace's state dir; `undefined` under `--dry`.    |
| `sessions`                   | `SessionStore`            | Raw message store behind `agents.session`.                |
| `agents.session(spec, opts)` | `Promise<SessionHarness>` | A remembering session for a registered agent.             |
| `log`                        | `(line: string) => void`  | Goes to the CLI's output.                                 |

A one-shot model turn is a `generateText` call from the `ai` SDK against a
harness model:

```ts
import { generateText } from "ai";

const summarize = step(
  "summarize",
  async ({ models, executors }, cwd: string) => {
    const [executor] = executors;
    const { text } = await generateText({
      model: models.model(executor.model, executor.provider, {
        workingDirectory: cwd,
      }),
      prompt: "Summarize what this repository does in three sentences.",
    });
    return { text };
  },
);
```

### `workflow(name, define)`

`define(graph)` composes registered steps. Each `graph.step(key, handle, input)`
maps earlier values to the child's input; `graph.output` shapes the result.
`sequence`, `parallel`, `race` and `branch` are the other combinators.

```ts
const pipeline = workflow<string, { text: string; greeted: string }>(
  "pipeline",
  (graph) => {
    graph
      .step("hello", hello, ({ input }) => input)
      .step("summary", summarize, () => ".")
      .output(({ hello, summary }) => ({
        greeted: hello.greeted,
        text: summary.text,
      }));
  },
);
```

### `agent(name, spec)`

A retained agent: prompt, optional `model`, `skills`, `mcp`. Open it as a
session inside a step. Give the session a stable `sessionId` and it remembers
across runs; omit it for a fresh one each time.

```ts
const librarian = agent("librarian", {
  prompt: "You track what changed in this repository between visits.",
});

const visit = step("visit", async ({ agents }, cwd: string) => {
  const session = await agents.session(librarian, {
    sessionId: "librarian",
    cwd,
  });
  const reply = await session.generate("What changed since your last visit?");
  return {
    text: reply.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n"),
  };
});
```

`SessionOptions`: `sessionId`, `executor` (defaults to the first), `cwd`
(confines the harness), `compaction` (`false`, or partial settings; on by
default).

### `schedule(name, { workflow, input, at })`

`workflow` is a handle or a registered name. `at` is either an interval,
`<n>s|m|h|d`, or a calendar slot, `{ weekday?, hour, minute? }` in machine-local
time: `{ weekday: "mon", hour: 9 }`, `{ weekday: ["mon", "wed", "fri"], hour: 9,
minute: 30 }`, `{ hour: 2 }` (daily). Interval cadence is measured from the end
of the last run, so a slow run delays the next tick rather than stacking them.

### `monitor(name, handler, options)`

A schedule that polls a source and runs `handler(primitives, change)` only
when something changed. Last-seen state lives in the workspace's state dir,
so a launchd tick knows what moved since the previous one.

```ts
monitor("guides", async ({ log }, change) => { ... }, "**/{CLAUDE,AGENTS}.md");

monitor("releases", async ({ agents }, change) => { ... }, {
  url: "https://api.github.com/repos/foo/bar/releases",
  headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
  every: "10m",
  select: (body) => body.map((release) => release.tag_name),
});
```

| Source | String         | Object                                               | `change`                                                        |
| ------ | -------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| files  | a glob         | `{ glob, root?, every? }`                            | `{ added, modified, removed }`, each with `path` and `checksum` |
| http   | an http(s) URL | `{ url, method?, headers?, body?, every?, select? }` | `{ status, previous, current }`, the selected values            |
| ws     | a ws(s) URL    | `{ url, headers?, protocols?, send?, select? }`      | `{ message }`, each message; `run` only                         |

`root` defaults to the config's directory. `every` defaults to 60 seconds and
takes the same forms as `schedule`. `select` names the part of the response
that counts as a change; without it, any byte moving counts. A failed poll
logs and keeps the last state. The handler runs on the first tick with
everything as `added` or `previous: undefined`.

Under `run`, files monitors also react to a native watcher and ws monitors
hold a socket (reconnecting after 5s), each event running the same handler
through the same tick; `once` and launchd poll, and a ws monitor under `once`
only logs that it is live-only.

### Helpers

- `loopUntil({ body, until, next, maxRounds })`: a Step that reruns a step or
  workflow until `until` says stop. Result: `{ output, rounds, settled }`.
- `workspaces.git(root).withWorktree({ base, branch? }, fn)`: check `base`
  out under the OS temp dir, run `fn`, always remove it. A `Worktree` is a
  `Git`, so `worktree.status()` works inside `fn`.
- Re-exported for direct use: `ModelManager`, `SessionHarness`,
  `WorkspaceSystem`, `Git`.

## Examples

### Watch guide files for drift

Add this to a `quirks.config.ts` in the repository root:

```ts
import { monitor } from "@foundry/quirks";

monitor("guides", ({ log }, change) => {
  log(JSON.stringify(change));
}, { glob: "**/{CLAUDE,AGENTS}.md", every: "30s" });
```

Run `bun run quirks run`. The handler logs added, modified and removed files
when the monitor detects a change.

### A reviewer that remembers

Same reviewer, same session id per base, so each scheduled review can say what
changed since its last one. This is the built-in `review-session`:

```ts
const reviewer = agent("reviewer", {
  prompt:
    "You review code. Read only; never edit, commit, or run anything that changes the tree.",
});

const reviewMain = step(
  "review-main",
  ({ agents, workspaces }, repository: string) =>
    workspaces
      .git(repository)
      .withWorktree({ base: "main" }, async (worktree) => {
        const session = await agents.session(reviewer, {
          sessionId: "review-main",
          cwd: worktree.root,
        });
        const reply = await session.generate(
          "Review this tree. If you reviewed it before, say what changed and what still stands.",
        );
        return {
          text: reply.parts
            .flatMap((p) => (p.type === "text" ? [p.text] : []))
            .join("\n"),
        };
      }),
);

schedule("nightly-review", {
  workflow: reviewMain,
  input: process.cwd(),
  at: { hour: 2 },
});
```

### Implement, review, repeat until clean

Two harnesses, two roles: the first implements, the second reviews, and
`loopUntil` feeds findings back until the review says `PASS`. Built in as
`develop`; the shape is:

```ts
const develop = workflow<DevelopInput, LoopUntilResult<DevelopRoundOutput>>(
  "develop",
  (graph) => {
    graph
      .step(
        "loop",
        loopUntil({
          body: developRound,
          until: ({ output }) => output.findings.length === 0,
          next: ({ output, round }, previous) => ({
            ...previous,
            round: round + 1,
            findings: output.findings,
          }),
          maxRounds: 5,
        }),
        ({ input }) => input,
      )
      .output(({ loop }) => loop);
  },
);
```

```sh
bun run quirks once develop --dry \
  --input '{"task":"Add a --json flag to list","cwd":".","round":1,"findings":[]}'
```

### Every harness reviews at once

One throwaway worktree, one `generateText` per detected harness, all in
parallel. Built in as `review-in-worktree`:

```sh
bun run quirks once review-in-worktree --dry --input '{"repository":".","base":"main"}'
```

### Mix tools in one step

A step is plain code, so the catalogue, git and a model compose freely. This
one asks a model to explain only the files git says changed:

```ts
const explainDiff = step(
  "explain-diff",
  async ({ models, executors, workspaces, log }, cwd: string) => {
    const status = await workspaces.git(cwd).status();
    if (status.kind !== "repository" || status.paths.length === 0)
      return { text: "clean" };
    log(`${String(status.paths.length)} changed paths`);
    const [executor] = executors;
    const { text } = await generateText({
      model: models.model(executor.model, executor.provider, {
        workingDirectory: cwd,
      }),
      prompt: `Explain these uncommitted changes, most important first:\n${status.paths.map((p) => p.path).join("\n")}`,
    });
    return { text };
  },
);
```

## Built-ins

With no config, `quirks list` shows `implement`, `review`, `develop-round`,
`develop`, `review-in-worktree` and `review-session`. They are written with
the same five factories, in `src/builtins.ts`, and double as the reference for
each pattern above.

## Contributing

`src/lib/` is the library; `src/cli.ts` is the command. Both build with one
tsup run so they share a registry chunk:

```sh
bun run --cwd=apps/quirks build       # dist/index.js (lib) + dist/cli.js
bun run --cwd=apps/quirks typecheck
bun run --cwd=apps/quirks lint
bun run --cwd=apps/quirks test
```

Tests run without a harness installed; `--dry` echoes model turns. Write a new
built-in with the same five factories a config uses: if the lib cannot say it,
the lib is missing something.
