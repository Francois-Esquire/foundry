---
name: marbles-config
description: Write, extend, or fix TypeScript automation modules for @foundry.sh/marbles — local automations made of steps, workflows, agents, schedules, and monitors. Use this whenever the user mentions Marbles, marbles.config.ts, @foundry.sh/marbles, or wants something to run on a clock, react to files or an HTTP endpoint changing, hand work to a coding agent (Codex, Claude Code), pause for a human approval, or publish a report or artifact — even if they never say "config". Also use it to review or debug an existing marbles.config.ts.
---

# Marbles automation modules

Marbles loads TypeScript automation modules from `.foundry/marbles/` in
an ordinary project. Modules register steps, workflows, and triggers through
`@foundry.sh/marbles`; exports are optional and useful for sharing definitions.
The standalone CLI runs one target with `marbles roll <name>` or keeps the
dashboard and triggers active with `marbles`.

Read `references/api.md` before writing a config for the first time in a
session. It is the whole surface in one page. Read
`references/patterns.md` when steps need to hand work to each other or when
a step asks a person something.

## The mental model in five lines

1. **Definitions carry defaults.** `agent`, `workspace`, `sandbox`,
   `artifact`, `skills` describe them. Nothing starts until used: an agent's
   own `generate` is one turn; `agents.session(agent)` is a conversation.
2. **Steps do the work.** `step(name).input(schema).output(schema).do(fn)`.
   `fn` gets one context object and returns the step's result.
3. **Locking builds the tree.** Calling a step, `review({}, { target: "." })`,
   locks one node: children first, literal input second. A parent runs after
   its children and receives their results under the keys you chose.
4. **Workflows name a tree.** `workflow("weekly", tree)` or
   `workflow("ship").input(schema).do(({ input }) => tree)`.
5. **Triggers start named things.** `schedule(target).at(slot)`,
   `schedule(target).every("6h")`, `monitor(source).do(fn)`.

## Procedure

Work top-down through the file in this order. Each section depends on the
one before it, so writing them in order keeps types flowing forward.

1. **Find or create an automation module.** Use `.foundry/marbles/` under the
   project root. `--source` selects a folder or single module; `--config` is
   a compatibility alias. The default folder uses the project above
   `.foundry` as its workspace. A custom folder uses itself; a standalone
   module uses its containing directory. Leading-underscore files and
   directories are excluded from discovery but remain importable. Keep
   helpers and tests there. The CLI supplies its own authoring package;
   libraries such as `zod` must resolve from the importing project. Use
   explicit names for launchable steps. For installation, use the standalone
   package archive; source builds belong in contributor setup.
2. **Ask what the user wants to happen, in one sentence each.** "Every Friday
   at four, review the packages folder and post a report." Each sentence
   becomes one trigger pointing at one named step or workflow. If the user is
   vague, write the smallest config that demonstrates the shape (one step, one
   trigger) and show it before adding more.
3. **Write the definitions.** One `agent` per role, with a prompt that states
   what it may and may not do ("Review without editing."). Add `provider:
   "codex"` or `"claude-code"` only when the user names one; without it the
   first installed CLI is used. Declare an `artifact` for anything that should
   accumulate versions across runs.
4. **Write the steps, named.** Give every step the user will launch, schedule,
   or monitor into an explicit name: `step("review")`. Nameless steps take
   their `const` name only when the project's own `typescript` resolves from
   the workspace root, and inference is a convenience, not a contract.
   Put `.input()` and `.output()` before `.do()` so the body is typed. Keep a
   step to one job; a step that opens an agent and returns its reply is three
   lines.
5. **Compose workflows.** Wire steps by reference. A step that needs another's
   result takes it as a child: `review({ branch: implement({}, { task }) })`.
   Siblings never talk to each other. A tree with children cannot be
   scheduled directly; wrap it: `workflow("weekly", tree)`. A workflow is a
   definition too: `weekly({})` locks it, which is what a monitor handler
   returns to launch it. A workflow is only ever a root, never a child.
6. **Add triggers last.** `schedule(weekly).at({ weekday: "fri", hour: 16 })`,
   `schedule(review({}, { target: "packages" })).every("6h")`,
   `monitor("docs/**/*.md").do(…)`, `monitor("https://…").every("5m").do(…)`.
   A monitor handler that returns a locked node starts it.
7. **Verify by loading.** Run the two commands below and read the output.
   `list` loads the config and prints every named step, workflow, schedule
   key, and monitor key; no step body runs. `roll` runs one of them, and
   `--dry-run` changes only what Marbles owns: agent turns, git mutations through
   `workspaces`, and sandbox commands are echoed instead of executed, and
   nothing is written under `~/.foundry`. The step bodies themselves still
   execute, so a raw `fetch`, a file write, or a child process in a body
   happens for real. Read the bodies before running `roll` on a config you
   did not write.
   `roll` has nobody to answer an `ask`: when a run reaches one it prints
   the cancellation reason and exits 1. That is the
   expected end of a dry run with an approval in it, not a bug in the
   config. Everything up to the ask ran; to go past it, open the dashboard
   (`marbles`), press Enter, and launch from there.

```sh
marbles --dry-run list
marbles --dry-run roll <name-or-key>
```

Restart a running dashboard after editing modules. Load first; execute only
when the user has authorized the effects, including external I/O that a dry
run still performs.

Use the keys `list` prints. A schedule's key is derived from its target and
input (`review-1becafa2`), a monitor's from its source (`docs-md-64d1e2`).
Never guess them.

Reading `--dry-run` output: `roll` labels steps by their path in the tree
(`weekly.findings`, `ship.decision.review.branch`), not by definition name,
so choose child keys that read well in a log. Agent turns are echoed as
`[provider/model] in <dir> <prompt>` and `generate().text` is that echo, so a
"finding" that reads like the prompt is expected. A turn with `{ output }`
is answered with the smallest value its schema accepts (required keys, empty
arrays, the first enum member), so a branch on that value takes its default
path. Sandbox commands are echoed
as `[sandbox] argv` and return exit 0 with empty output, so a failure branch
never runs under `--dry-run`; test it by forcing the value once. Reports and
artifacts are recorded (a version id is returned) but not echoed. Nothing is
written under `~/.foundry`.

To exercise a monitor's handler, run `roll <monitor-key>`. With no stored
baseline every matching file arrives as `added` (or the first HTTP body
counts as a change), so the handler runs and anything it launches is
started, all echoed.

## Rules that bite

Each of these is enforced when the modules load or when a step replays. Knowing
why they exist lets you design around them instead of hitting them.

- **Children first, input second.** `review({ branch: implement({}, { task }) })`
  is a child; `review({}, { target: "." })` is a literal. A key present in both
  is an error. The body sees them merged as `input`.
- **Declare children in the parent's `.input()`.** `publish` that receives
  `{ findings, exitCode }` declares both in its schema. Each child's output is
  checked against that key at lock time, which is where mismatches surface.
- **A trigger target is a named definition or a childless lock of one.**
  `schedule(publish.parallel({ … }))` throws `wrap it in a named workflow
  first`. A nameless target throws `has no name`; name it. A monitor
  launches only what its handler *returns as a lock*: `ship({}, { task })`
  or `nightly({})`. A bare definition returned is ignored.
- **An `ask` needs the dashboard.** Only a process that can show the question
  parks the run; `roll` and headless `run` cancel it at the ask instead.
  Design flows with approvals to be launched from the dashboard, or by a
  schedule or monitor while the dashboard is open.
- **Bodies replay.** Resuming an `ask` or pause, including an adopted parked
  run after restart, replays the unfinished body from the top. Calls to
  `agents.session`, `sandboxes.start`, and `ask.*`
  are numbered by order and return the recorded thing on replay, so keep them
  in a fixed order and put effects that must not repeat after the final ask
  or in a preceding child step. An explicit `session.generate` can send
  another turn on replay; a one-shot `agent.generate` reuses its recorded
  completed reply when available. Ask first: `approve` in the reference
  module does nothing before its approval.
- **Workflow setup is not durable.** A workflow's `.do` runs on every setup,
  including resume. It prepares and returns the tree; anything it must keep
  goes into a step as input.
- **Finished results are reused within a run.** A new launch starts fresh
  work. Sessions, artifacts, and trigger observations have their own
  persistent stores. The CLI saves run snapshots at suspension, resumption,
  and settlement, and adopts only parked runs after restart; progress
  newer than the last saved snapshot may be lost.
- **Retries are built in and opt in.** Configure the step with
  `.config({ retry: { maxAttempts: 3 } })` when its effects can safely repeat.
  The limit includes the first attempt. Retries run fresh managed operations;
  completed children in the same run keep their results. A parent's policy
  does not configure its children; `bail(error)` does not retry.
  See [Durability](https://francois-esquire.github.io/foundry/marbles/foundation/durability/)
  and [Foundry primitives](https://francois-esquire.github.io/foundry/marbles/foundation/primitives/).
- **Sessions are fresh by default.** Pass `{ session }` to continue one. To
  continue across runs, return `session.ref` from the step and feed it back
  next time (see patterns).
- **Working directory flows.** A session or sandbox opened inside a worktree
  callback runs in the worktree. Pass `{ cwd }` only to leave that default.
- **`signal` is for what Marbles does not own.** Agent turns, sandbox commands,
  and worktrees are already cancelled with the step. Pass `signal` to a raw
  `fetch` or child process.
- **Sandboxes mount the step's working directory.** `mount: "."` is the
  config's directory, or the worktree when the sandbox starts inside a
  worktree callback. `mount: someWorkspace` mounts a declared workspace.
  Nothing else is mountable; any other path fails at run time with `escapes
  the trusted host roots`. `sandboxes.start` needs the optional
  `microsandbox` peer; the `files` form seeds a scratch container under
  `/workspace` with no mount.

## What a good config looks like

```ts
import { agent, artifact, monitor, schedule, step, workflow } from "@foundry.sh/marbles";
import { z } from "zod";

const reviewer = agent({ prompt: "Review without editing. List findings, most important first." });
const reviewReport = artifact({ name: "Review report", type: "text/markdown" });

const review = step("review")
  .describe("Read-only review of a folder or a branch.")
  .input(z.object({ target: z.string().default("."), branch: z.string().optional() }))
  .output(z.string())
  .do(async ({ input: { target, branch }, agents, log }) => {
    log("reviewing", branch ?? target);
    const session = await agents.session(reviewer);
    const subject = branch ? `branch ${branch} against main` : target;
    return (await session.generate(`Review ${subject}.`)).text;
  });

const publish = step("publish")
  .input(z.object({ findings: z.string() }))
  .do(async ({ input: { findings }, report }) => {
    const version = await report.artifact(reviewReport, { "report.md": findings });
    return version.id;
  });

const weekly = workflow("weekly", publish({ findings: review({}, { target: "packages" }) }));

schedule(weekly).at({ weekday: "fri", hour: 16 });
monitor("src/**/*.ts").every("10m").do(({ files, log }) => log(files.modified.length, "changed"));
```

What makes it good: every launchable thing is named, schemas come before
bodies, the agent's prompt states its limits, the parent declares its child's
key, and the trigger points at a workflow rather than a tree.

## When something fails to load

The error text is the diagnosis. The common ones:

| Error contains | Cause | Fix |
| --- | --- | --- |
| `has no name … give it one: step("name")` | A nameless step used as a trigger or launch target, and no `typescript` to infer from | Name the step |
| `a locked tree has children; wrap it in a named workflow first` | A tree passed to `schedule` or returned from a monitor | Wrap it: `workflow("name", tree)`, then schedule the workflow |
| `a workflow can only be the root of a run` | A workflow locked as a child of another tree | Lock its steps there instead |
| `agent "x" already declared … with a different prompt or route` | Two different agents resolve to one id (same `name` or `const`) | Rename one or give it `name` |
| `already registered` | Two definitions share a name; the message says whether one came from a `const` and where | Rename one or name it explicitly |
| `child "x" is not a locked node; call the definition first` | A definition passed as a child without calling it | `x({})` |
| `child "x" is not an input key (declared: …)` | The parent's `.input()` does not declare that child key | Add it to the schema or rename the key |
| `"x" is both a child and an input key` | Same key passed as a child and as a literal | Keep one |
| `setup must return a locked node` | A workflow's `.do` returned a definition or nothing | Return a locked tree |
| `Cannot find package 'zod'` | The schema library is not installed beside the config | Install it in the config's project |

## Out of scope for this skill

Building the `@foundry.sh/marbles` library itself, the dashboard, or operating
system service setup. Schedules and monitors run while Marbles stays open;
`marbles roll <key>` runs one tick and exits.
