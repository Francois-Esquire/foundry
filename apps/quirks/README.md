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

## Coding inside MicroSandbox

A sandbox session prepares the Linux CLI before its first turn. MicroSandbox
consumes the base image directly. Claude Code uses the host subscription login;
only the current access token enters the guest process. Host login directories
and refresh credentials remain on the host. An explicit `oauthToken` from
`claude setup-token` can select a different subscription credential.

```ts
import { agent, step } from "@foundry/quirks";

const coder = agent({
  provider: "claude-code",
  model: "sonnet",
  prompt: "Make focused fixes in /workspace and verify them with bun test.",
});

step("fix-fixture").do(async ({ agents, sandboxes }) => {
  const box = await sandboxes.start({
    image: "docker.io/oven/bun:1-slim",
    executable: true,
    network: {
      mode: "allowlist",
      destinations: [{ host: "api.anthropic.com", ports: [443] }],
    },
  });
  const session = await agents.session(coder, {
    sandbox: box,
    profile: {
      mode: "scheduled",
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(bun test:*)"],
      disallowedTools: [],
      unresolved: "deny",
      maxSteps: 20,
    },
  });
  return (await session.generate("Fix the failing test without changing the test.")).text;
});
```

Network access defaults to disabled, and executable workspace mounts are opt-in.
Native session history currently resumes only while the same guest remains
alive; reopening against a replacement guest fails explicitly. Scheduled
approval requests are recorded and denied for that invocation. Attended hosts
supply an in-process callback through `authority`; it must not call the workflow
`ask` suspension API.

Embedding hosts can register network providers through `bindRuntime.providers`.
These use the built-in coding loop with scoped guest tools, a step limit, and
compaction. The existing OpenAI-compatible gateway provider also supports
OpenRouter configuration. Legacy sessions without `sandbox` retain their prior
execution path; new profiles and credential options require a sandbox.

The standalone bundle includes the OpenAI-compatible SDK dependencies used by
the built-in path; their narrow Knip exceptions reflect bundled workspace imports.

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
