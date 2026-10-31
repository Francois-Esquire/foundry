---
title: Your first automation
description: Write a small TypeScript automation, inspect its output, and change it.
---

Build a file inventory for a local project. By the end, you will have run
it twice and seen how a change to its code changes the result.

You need the [Marbles CLI](/marbles/get-started/installation) and a project
directory. This example reads files and writes Marbles run history. It
needs no agent credentials, Git repository, or extra library.

## Write the automation

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
it. `workspaces.current` refers to your project root, and `log` writes to
the run's output. The returned object is the result.

The file inventory comes from [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md).
Marbles attaches it to a step so you can inspect its result as a run, just
as you would later inspect a command or an agent's work.

## Run it

Stay in the project root:

```sh
marbles list
marbles roll inventory
```

`list` should include `inventory`. `roll` runs it immediately and prints a
result like `{"files":12}` alongside run status and your log line. The count
depends on the files visible to the workspace scanner and its ignore rules.

If nothing is listed, check the filename and your current directory. The
default source is `./.foundry/marbles`; a name beginning with `_` is excluded
from automatic discovery.

## Change it and run again

Replace the step with this version, keeping the import:

```ts
step("inventory").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  const typescript = files.filter((file) => file.path.endsWith(".ts"));
  log(`Found ${typescript.length} TypeScript files`);
  return { files: files.length, typescript: typescript.length };
});
```

```sh
marbles roll inventory
```

The result now includes `typescript`. The workspace's worker in the Marbles
process notices the edit and reloads before the next `roll`; an open
dashboard shows `reloading` and then the new module. Nothing needs
restarting.

## Find the run again

`marbles status` shows the workspace and its recent runs. To explore them in
the dashboard, run `marbles`, press Enter at the splash, and select a run in
the Runs panel. Its details include the steps and their output. Press `?`
for keyboard help and `q` to open the quit dialog.

Run history lives under `~/.foundry/marbles/<workspace-id>/`. Your automation
source stays in the project. [State reference](/marbles/reference/state)
explains the layout and how to choose a different location.

Marbles keeps the result after the command exits. Each `roll` starts a new
run. Later, [durability](/marbles/foundation/durability) explains how a
waiting workflow can continue using its finished steps' results.

## Choose the next capability

[Using Marbles](/marbles/get-started/using-marbles) shows how to add input,
commands, agents, workflows, and schedules. A single step is already a
complete automation.
