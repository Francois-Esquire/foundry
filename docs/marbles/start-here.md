---
title: Start Here
description: Get the Marbles CLI running, write one step, give it input, and add an agent.
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

## Create one step

Marbles reads modules from `.foundry/marbles/` in the directory you run it
from. Save this as `.foundry/marbles/inspect.ts`:

```ts
import { schedule, step } from "@foundry/marbles";

const inspect = step("inspect").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  log(files.length, "files");
  return { files: files.length };
});

schedule(inspect).every("1h");
```

The step lists the files of the workspace root and returns their count. It
makes no model calls and needs no installed agent harness.

Prefer a starter? `marbles init` writes a codebase-summary module, and
`marbles init developer` or `marbles init design` writes a review or
prototype step instead. Opening `marbles` without an authoring folder offers
the same setup interactively.

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
It opens the dashboard; Enter starts the triggers, and `q` quits.

## Give it input

A schema before the body gives the step typed, validated input. Add this
module beside the first, in a project that has `zod` installed:

```ts
import { step } from "@foundry/marbles";
import { z } from "zod";

step("count")
  .input(z.object({ extension: z.string() }))
  .do(async ({ input: { extension }, workspaces }) => {
    const files = await workspaces.current.files();
    return { extension, files: files.filter((file) => file.endsWith(extension)).length };
  });
```

```sh
marbles roll count --input '{"extension":".ts"}'
```

`roll` parses the JSON, validates it against the schema, and runs the body.
The same schema builds the launch form in the dashboard. Any
[Standard Schema](https://standardschema.dev) library works; the docs use zod.
It must resolve from the importing file, because the CLI supplies
`@foundry/marbles` itself but not the schema library.

The body receives one object. Destructure `input` and whatever else it needs:
`log`, `agents`, `workspaces`, `ask`, `report`. The
[API reference](/marbles/reference/api#context) lists every key.

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
kept. The session runs in the workspace root without being told. Read
[safety and limits](/marbles/safety-and-limits) before using agents on work
you care about.

## Next steps

- [Concepts](/marbles/concepts) explains how steps compose into workflows,
  how agents keep a conversation, and how triggers bring work back.
- [The Software Factory](/marbles/guides/software-factory) builds a complete
  automation, one station at a time.
- [CLI reference](/marbles/reference/cli) covers every command and flag.
