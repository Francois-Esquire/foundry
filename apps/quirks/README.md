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
