# Quirks

**Quirks turns recurring behaviors into inspectable TypeScript.**

Composable local automation, with agents where judgment is useful. Define what
should happen, what should be watched, when it should run, and where an agent
may participate. Run it once, keep it active in a terminal, or let launchd invoke
it on a schedule.

Five factories compose ordinary code, model turns, and retained conversations:
`step`, `workflow`, `agent`, `schedule`, and `monitor`.

## Start small

Requires Bun 1.3.14 or newer:

```sh
bun add --global @foundry/quirks
```

Create `quirks.config.ts`:

```ts
import { readdir } from "node:fs/promises";
import { schedule, step } from "@foundry/quirks";

const countFiles = step("count-files", async ({ workspace, log }) => {
  const entries = await readdir(workspace.root, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).length;
  log(`${files} files at the workspace root`);
  return { files };
});

schedule("count-hourly", { workflow: countFiles, input: null, at: "1h" });
```

```sh
quirks once count-files
quirks                 # same as quirks run
quirks run
quirks status
```

In a terminal, `quirks` and `quirks run` open the Gruvbox splash, load your
configuration and saved run history, then wait for Enter or a click. Enter opens
the Triggers, Catalog, and Runs dashboard and starts schedules and monitors.
A missing config opens a guided setup for Developer/code review, Design/prototype,
or Product/codebase summary. It creates only your selected prebuilt step.
A valid empty configuration opens the dashboard directly; nothing registers by default. `quirks --help` prints usage.
Piped or redirected runs use plain text and start immediately.

Press `q` or Ctrl+C to open the quit dialog; Ctrl+C again confirms. Quitting stops
triggers and cancels active runs. Saved results and monitor checkpoints remain;
interrupted runs cannot resume. Custom steps receive `signal` in their context
and should pass it to cancellable operations such as `fetch`. Cancellation does
not undo side effects or forcibly stop custom work that ignores the signal.

Deterministic steps need no agent harness. For model operations, install and
authenticate Claude Code or Codex. The CLI resolves configuration imports of
`@foundry/quirks` and `@foundry/quirks/prebuilt` to its own installation, including when installed globally.

State is saved to disk between invocations. `--dry` substitutes supplied model
and Git operations and disables Quirks state persistence; it does not contain
custom code, monitor I/O, or launchd installation and removal. Working directories
are execution context, not security sandboxes.

## Start with a prebuilt step

```ts
import { summarizeCodebase } from "@foundry/quirks/prebuilt";
summarizeCodebase();
```

Press `2` for Catalog, Enter for details, then `l` or click Launch. Steps and
workflows with declared arguments open a form; argument-free definitions start
immediately. The dashboard selects the new run while triggers continue running.
Custom definitions declare fields in the third `step`/`workflow` argument:
`{ input: { fields: [] } }` explicitly means no arguments. See the configuration
reference for text, multiline, number, boolean, and choice fields.

## Documentation

- [Introduction](https://francois-esquire.github.io/foundry/quirks/)
- [Start Here](https://francois-esquire.github.io/foundry/quirks/start-here/)
- [Concepts](https://francois-esquire.github.io/foundry/quirks/concepts/)
- [Use Cases](https://francois-esquire.github.io/foundry/quirks/use-cases/)
- [API reference](https://francois-esquire.github.io/foundry/quirks/reference/factories/)
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
