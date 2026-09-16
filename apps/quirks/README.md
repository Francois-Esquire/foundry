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
quirks run
quirks status
```

Deterministic steps need no agent harness. For model operations, install and
authenticate Claude Code or Codex. The CLI resolves configuration imports of
`@foundry/quirks` to its own installation, including when installed globally.

State is saved to disk between invocations. `--dry` substitutes supplied model
and Git operations and disables Quirks state persistence; it does not contain
custom code, monitor I/O, or launchd installation and removal. Working directories
are execution context, not security sandboxes.

## Documentation

- [Introduction](https://github.com/Francois-Esquire/foundry/blob/main/docs/quirks/index.md)
- [Start Here](https://github.com/Francois-Esquire/foundry/blob/main/docs/quirks/start-here.md)
- [Concepts](https://github.com/Francois-Esquire/foundry/blob/main/docs/quirks/concepts/index.mdx)
- [Use Cases](https://github.com/Francois-Esquire/foundry/blob/main/docs/quirks/use-cases/index.mdx)
- [API reference](https://github.com/Francois-Esquire/foundry/blob/main/docs/quirks/reference/factories.md)
- [CLI reference](https://github.com/Francois-Esquire/foundry/blob/main/docs/quirks/reference/cli.md)
- [Safety and Limits](https://github.com/Francois-Esquire/foundry/blob/main/docs/quirks/safety-and-limits.mdx)
- [Contributing](https://github.com/Francois-Esquire/foundry/blob/main/docs/quirks/contributing.md)

Repository setup and documentation development commands are in the contributing guide.
