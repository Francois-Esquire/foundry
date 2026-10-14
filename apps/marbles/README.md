# Marbles

Marbles is a standalone CLI for automations you write in TypeScript. Run
local commands, connect steps into workflows, react to changes, and add
coding agents where a task needs judgment.

[Workflows](../../packages/workflows/README.md) records step results and
provides optional retries and durable waiting points.
[Agents](../../packages/agents/README.md) keeps conversations,
[Workspaces](../../packages/workspaces/README.md) provides files and Git
checkouts, and [Artifacts](../../packages/artifacts/README.md) keeps
versioned outputs. Marbles bundles these libraries.

## Install

Requires Bun 1.3.14 or newer. The package is not yet on npm; install a
packaged archive supplied by a maintainer:

```sh
bun add --global /absolute/path/to/foundry-marbles-0.1.0.tgz
marbles --help
```

The [installation guide](https://francois-esquire.github.io/foundry/marbles/get-started/installation/)
covers editor types and optional capabilities. Contributors can
[build an archive](https://francois-esquire.github.io/foundry/marbles/contributing/#build-a-distributable-package).

## Write one automation

Save this as `.foundry/marbles/inventory.ts` in your project:

```ts
import { step } from "@foundry/marbles";

step("inventory").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  log(`Found ${files.length} files`);
  return { files: files.length };
});
```

From that project's root:

```sh
marbles list
marbles roll inventory
```

The result contains the file count. This example needs no agent credentials
or sandbox runtime. The [quickstart](https://francois-esquire.github.io/foundry/marbles/get-started/quickstart/)
continues with an edit-and-rerun cycle and result inspection.

## Run locally

`marbles` opens a dashboard; press Enter to start schedules and monitors.
`marbles run </dev/null` starts a headless loop immediately. Keep the process
running for automatic triggers. The dashboard can answer questions;
`roll` and headless execution cancel at a workflow ask.

State is stored under `~/.foundry/marbles/<workspace-id>/`, with artifacts
under `~/.foundry/artifacts/` by default. Restart to load edited modules.
`--dry-run` substitutes Marbles-owned operations and avoids state writes;
ordinary TypeScript and monitor I/O still execute.

## Documentation

| Need | Read |
| --- | --- |
| Explore what you can build | [Using Marbles](https://francois-esquire.github.io/foundry/marbles/get-started/using-marbles/) |
| Understand definitions, runs, resources, and durability | [Foundation](https://francois-esquire.github.io/foundry/marbles/foundation/api/) |
| Build an issue-driven development cycle | [Software Factory](https://francois-esquire.github.io/foundry/marbles/use-cases/software-factory/) |
| Look up commands or authoring options | [CLI](https://francois-esquire.github.io/foundry/marbles/reference/cli/) and [API](https://francois-esquire.github.io/foundry/marbles/reference/api/) |
| Operate or troubleshoot the runtime | [State](https://francois-esquire.github.io/foundry/marbles/reference/state/), [safety](https://francois-esquire.github.io/foundry/marbles/reference/safety/), and [remote execution](https://francois-esquire.github.io/foundry/marbles/reference/remote/) |
| Host or develop Marbles | [Embedding](https://francois-esquire.github.io/foundry/marbles/reference/engine/) and [Contributing](https://francois-esquire.github.io/foundry/marbles/contributing/) |

For terminal UI development, see the [preview guide](preview/README.md).
