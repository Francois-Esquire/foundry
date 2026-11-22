---
title: Marbles
description: The parts of an agent harness, as TypeScript scripts you compose into an outer loop.
sidebar:
  label: Introduction
---

You already run an agent harness by hand. You ask Claude Code or Codex to
read a diff, run the tests in another terminal, check how much of this
week's quota is left, and wait for someone to say "ship it". Marbles gives
each of those parts a name in TypeScript. You write a short script, and the
`marbles` CLI runs it, keeps its history, and shows you what it is doing.

Marbles is **alpha**, starting at `0.0.1`. Any `0.0.x` release may introduce
breaking changes. `0.1.0` will mark the first supported API baseline.

## Your rituals, as scripts

Each ritual maps to one or two marbles:

| What you do by hand | The marble |
| --- | --- |
| Run lint and tests, and ask an agent to read the diff | Three steps under `verdict.parallel(...)` |
| Try a change in a clean checkout | `workspaces.current.git.withWorktree(...)` |
| Switch to Codex when Claude's weekly quota runs low | `usage.share("anthropic")` and `reviewer.extend({ provider })` |
| Wait for a person to approve before pushing | `await ask.approval({ title })` |
| Pick a long conversation back up where it stopped | `agents.session(reviewer, { session: ref })` |

Here is the first ritual as a file in your project,
`.foundry/marbles/pre-push.ts`:

```ts
import { agent, step, workflow } from "@foundry.sh/marbles";
import { z } from "zod";

const command = z.object({ exitCode: z.number() });
const lint = step("lint").exec("bun run lint", { check: false });
const tests = step("tests").exec("bun test", { check: false });

const reviewer = agent({ prompt: "Review the uncommitted changes. Do not edit files." });
const review = step("review").do(async () => (await reviewer.generate("Review `git diff HEAD`.")).text);

const verdict = step("verdict")
  .input(z.object({ lint: command, review: z.string(), tests: command }))
  .do(({ input }) => input);

workflow("pre-push", () => verdict.parallel({ lint: lint(), review: review(), tests: tests() }));
```

`marbles roll pre-push` runs lint, tests, and the review at the same time,
then prints all three results. The run stays in local history, so you can
open it later in the dashboard and read each step's output. The
[quickstart](/marbles/get-started/quickstart) builds this file one piece at a
time, starting with a version that needs no agent account.

## The outer loop

Once a ritual is a script, something other than you can start it. Marbles
keeps a backlog of `tasks` in workspace state. `observe(tasks, handler)`
runs your handler after every task change. `.launch()` starts a run and
hands back its id without waiting for it to finish, and a key makes it
launch once however often the handler repeats. `monitor` and `schedule`
add work when a file changes or a clock ticks.

```ts
observe(tasks, async function dispatch() {
  const ready = await tasks.ready({ tags: { all: ["checks"] } });
  for (const task of ready.items) {
    await checkTask.launch({ task: task.id }, { key: `check:${task.id}` });
    await tasks.start(task.id, { expectedUpdatedAt: task.updatedAt });
  }
});
```

```text
you, a monitor, a schedule, an MCP client
        │
        ▼
      tasks ──▶ observe ──▶ .launch() ──▶ runs ──▶ results, approvals
        ▲                                               │
        └──────────── findings, follow-up tasks ◀───────┘
```

That loop is the point of Marbles. Each piece stays a small script you can
run on its own with `marbles roll`. Composed, they keep working after you
close the terminal: the Marbles process hosts the workspace, fires its
triggers, and parks any run that asks a question until you answer it in the
dashboard. [The outer loop](/marbles/get-started/outer-loop) builds a working
one in about 70 lines.

## Find your way

- **Get started.** [Install](/marbles/get-started/installation), script
  [your first ritual](/marbles/get-started/quickstart), close
  [the outer loop](/marbles/get-started/outer-loop), and learn where things
  live in [the Marbles UI](/marbles/get-started/marbles-ui).
- **Concepts.** [How the parts fit](/marbles/concepts) explains steps,
  agents, tasks, triggers, workspaces, and durability, and how each one
  connects to the others.
- **Use cases.** Start small and grow:

| Blueprint | Marbles involved |
| --- | --- |
| [Docs drift watcher](/marbles/use-cases/docs-drift) | `monitor`, an agent with structured output, `report.artifact` |
| [Release patrol](/marbles/use-cases/release-patrol) | An HTTP `monitor`, an agent routed by `usage`, `tasks` |
| [Evaluations](/marbles/use-cases/evaluations) | Model and skill trials kept as artifacts |
| [Design](/marbles/use-cases/design) | Briefs, wireframes, and design-token sync |
| [Productivity](/marbles/use-cases/productivity) | A morning briefing from GitHub, Slack, and Google Docs |
| [Software Factory](/marbles/use-cases/software-factory) | `tasks`, `observe`, keyed `.launch()`, a nested workflow, worktrees, `.parallel`, and `ask.approval`, taking a task to an approved pull request |

The [reference](/marbles/reference/cli) covers commands, the API, the MCP
server, project setup, and troubleshooting. The [Library](/marbles/library)
runs definitions from your own program. The [roadmap](/marbles/roadmap)
lists what comes next, including browser resources, a first-class MCP
definition, and a hosted application.

Examples on these pages follow the source checkout. Where a page uses
`.launch()`, `runs`, observers in `marbles list`, zero-argument
locks such as `lint()`, `agent(name, fn)`, `monitor(...).name()`, or
`.exec` options computed from the context, it needs a
[checkout-built package](/marbles/contributing#build-a-distributable-package)
until the next release. The published `0.0.4` package runs the rest.
