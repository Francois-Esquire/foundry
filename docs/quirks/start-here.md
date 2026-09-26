---
title: Start Here
description: Get the Quirks CLI running and dispatch a deterministic behavior once or on a schedule.
---

`@foundry/quirks` is not published to npm yet. It runs from the Foundry
repository with Bun 1.3.14 or newer.

```sh
git clone https://github.com/Francois-Esquire/foundry.git
cd foundry && bun install
bun run quirks -- --help
```

Inside the repository the command is `bun run quirks -- …`. To use it from
another directory, build the CLI once and run the built file:

```sh
cd apps/quirks && bun run build
bun /path/to/foundry/apps/quirks/dist/cli.js --help
```

The rest of these pages write `quirks …`; substitute either form. Point the
CLI at a config outside the repository with `--config <path>`.

## Create one behavior

Save this as `quirks.config.ts` in the directory you want to inspect:

```ts
import { schedule, step } from "@foundry/quirks";

const inspect = step("inspect").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  log(files.length, "files");
  return { files: files.length };
});

schedule(inspect).every("1h");
```

The step lists the files of the directory that holds the config and returns
their count. It makes no model calls and needs no installed agent harness.

## Run and inspect

```sh
quirks --config ./quirks.config.ts list
quirks --config ./quirks.config.ts once inspect
quirks --config ./quirks.config.ts status
```

`list` prints the step and the schedule with its key, `inspect`, and cadence.
Declaring a schedule does not start a clock. `once inspect` dispatches it now
and prints the result. `--dry` runs the same thing without writing state.

To keep the schedule active in your terminal, run `quirks` with no command.
It opens the dashboard; Enter starts the triggers, and `q` quits. For
scheduled processes on macOS, continue to [launchd](/quirks/guides/launchd).

## Add judgment when it helps

With an installed, authenticated Claude Code or Codex CLI, add an agent:

```ts
import { agent, step } from "@foundry/quirks";

const guide = agent({ prompt: "Explain this workspace. Ask before proposing changes." });

step("explain").do(async ({ agents }) => {
  const session = await agents.session(guide);
  const reply = await session.generate("What should I understand about this workspace?");
  return reply.text;
});
```

Run `quirks once explain`, then `quirks sessions` to see the conversation it
kept. The session runs in the config's directory without being told; the
prompt supplies behavioral instructions, not permissions. Read
[safety and limits](/quirks/safety-and-limits) before using agents on work
you care about.

## Next steps

- [Concepts](/quirks/concepts) explains the nine words and how they compose.
- [Your first behavior](/quirks/guides/first-behavior) composes a small workflow.
- [CLI reference](/quirks/reference/cli) covers every command and flag.
