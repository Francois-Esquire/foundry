---
title: Your first ritual
description: Run one step with no credentials, script your pre-push checks, then add an agent review beside them.
---

This page turns a pre-push ritual into a script in three moves. The first
needs nothing but the [Marbles CLI](/marbles/get-started/installation). The
second adds `zod`. The third adds an agent and needs an authenticated
Claude Code or Codex CLI (or Pi, once the workspace's source calls
[`defineProvider(pi)`](/marbles/reference/api#providers)).

## Run one step

From your project root, create the authoring directory:

```sh
mkdir -p .foundry/marbles
```

Save this complete module as `.foundry/marbles/inventory.ts`:

```ts
import { step } from "@foundry.sh/marbles";

step("inventory").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  log(`Found ${files.length} files`);
  return { files: files.length };
});
```

`step` registers work named `inventory`. Its callback runs when you launch
it. `workspaces.current` is your project root, and `log` writes to the run's
output. The returned object is the result.

```sh
marbles list
marbles run inventory
```

`list` should include `[step] inventory`. `marbles run` runs it and prints your log
line and a result like `{"files":12}`. The count depends on the files the
[Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md)
scanner sees after its ignore rules.

If nothing is listed, check the filename and your current directory. The
default source is `./.foundry/marbles`, and a name beginning with `_` is left
out of discovery.

## Script the checks

Before a push you probably run lint and tests. Install the schema library,
then save `.foundry/marbles/pre-push.ts`:

```sh
bun add zod@4.4.3
```

```ts
import { step, workflow } from "@foundry.sh/marbles";
import { z } from "zod";

const command = z.object({ exitCode: z.number(), stderr: z.string() });

const lint = step("lint").exec("bun run lint", { check: false });
const tests = step("tests").exec("bun test", { check: false });

const verdict = step("verdict")
  .input(z.object({ lint: command, tests: command }))
  .do(({ input }) => ({
    lint: input.lint.exitCode === 0,
    tests: input.tests.exitCode === 0,
  }));

workflow("pre-push", () => verdict.parallel({ lint: lint(), tests: tests() }));
```

Swap in your project's own commands. Then run it:

```sh
marbles run pre-push
```

Here is what each part does:

- `.exec("bun test", { check: false })` makes a step that is one command.
  Its result is `{ exitCode, stdout, stderr }`. With `check: false` a
  failing command is a result, not a failed step.
- `verdict` declares the results it consumes in its input schema. A parent
  runs after its children and receives their results under the same keys.
- `.parallel(...)` runs the children at the same time. Calling a definition
  with no arguments, as in `lint()`, places it in the tree as a leaf. On the
  published `0.0.4` package, write `lint({})` instead.
- `workflow("pre-push", ...)` names the tree so `marbles run` can find it.

## Add an agent review

The review you usually ask for in a chat window becomes a third child. With
an authenticated agent CLI, replace the file with this version:

<include>./_example/pre-push.ts</include>

`agent(...)` declares instructions, and `generate` runs one turn on a fresh
session inside the step. The turn uses the step's working directory, writes
to its output, and stops if you cancel the run. `marbles run pre-push` now
returns lint, tests, and the agent's findings together.

A prompt that says "do not edit files" is an instruction, not a permission.
To review in a throwaway checkout instead of your working tree, wrap the
turn in `workspaces.current.git.withWorktree(...)`; see
[Workspaces, sandboxes, and artifacts](/marbles/concepts/workspaces-and-artifacts#temporary-git-worktrees).

## Edit and run again

Change a prompt or a command and run `marbles run pre-push` again. The
Marbles process notices the edit and starts its next engine generation,
which takes over before your next `marbles run`. An open dashboard shows
`reloading` and then the new module. Nothing needs restarting.

Each `marbles run` starts a new run. `marbles status` shows the workspace and its
recent runs, and `marbles` opens the dashboard, where the Runs panel shows
each step's output. Run history lives under
`~/.foundry/marbles/<workspace-id>/`; your source stays in the project. The
[state reference](/marbles/reference/state) explains the layout.

## Next

The ritual still waits for you to type `marbles run`.
[The outer loop](/marbles/get-started/outer-loop) gives it a backlog and a
dispatcher, so it runs when work appears.
