---
title: Start Here
description: Get the Marbles CLI running and dispatch a deterministic automation once or on a schedule.
---

`@foundry/marbles` is not published to npm yet. It runs from the Foundry
repository with Bun 1.3.14 or newer.

```sh
git clone https://github.com/Francois-Esquire/foundry.git
cd foundry && bun install
bun run marbles -- --help
```

Inside the repository the command is `bun run marbles -- …`. To use it from
another directory, build the CLI once and run the built file:

```sh
cd apps/marbles && bun run build
bun /path/to/foundry/apps/marbles/dist/cli.js --help
```

The rest of these pages write `marbles …`; substitute either form. Point the
CLI at an authoring folder or module outside the repository with `--source <path>`.

## Set up a workspace

Run `marbles init` from your project root for a codebase-summary starter.
Choose `marbles init developer` for code review or `marbles init design`
for a prototype step. Opening `marbles` without an authoring folder offers
interactive setup instead.

The following example needs no agent harness. Create `.foundry/marbles/`
if it does not exist, then add the module below. Files and directories with
a leading underscore are skipped by discovery but remain importable. See
[authoring](/marbles/reference/configuration) for helpers and micro apps.

## Create one step

Save this as `.foundry/marbles/inspect.ts` in the directory you want to inspect:

```ts
import { schedule, step } from "@foundry/marbles";

const inspect = step("inspect").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  log(files.length, "files");
  return { files: files.length };
});

schedule(inspect).every("1h");
```

The step lists the files of the workspace root and returns
their count. It makes no model calls and needs no installed agent harness.

## Run and inspect

```sh
marbles list
marbles roll inspect
marbles status
```

`list` prints the step and the schedule with its key, `inspect`, and cadence.
Declaring a schedule does not start a clock. `roll inspect` dispatches it now
and prints the result. `--dry-run` runs the same thing without writing state.

To keep the schedule active in your terminal, run `marbles` with no command.
It opens the dashboard; Enter starts the triggers, and `q` quits. For
scheduled processes on macOS, continue to [launchd](/marbles/guides/launchd).

## Add judgment when it helps

With an installed, authenticated Claude Code or Codex CLI, add an agent:

```ts
import { agent, step } from "@foundry/marbles";

const guide = agent({ prompt: "Explain this workspace. Ask before proposing changes." });

step("explain").do(async ({ agents }) => {
  const session = await agents.session(guide);
  const reply = await session.generate("What should I understand about this workspace?");
  return reply.text;
});
```

Run `marbles roll explain`, then `marbles sessions` to see the conversation it
kept. The session runs in the workspace root without being told; the
prompt supplies agent instructions, not permissions. Read
[safety and limits](/marbles/safety-and-limits) before using agents on work
you care about.

## Next steps

- [Concepts](/marbles/concepts) explains the nine words and how they compose.
- [Your first workflow](/marbles/guides/first-workflow) composes a small workflow.
- [CLI reference](/marbles/reference/cli) covers every command and flag.
