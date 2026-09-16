---
title: Start Here
description: Install Quirks and run a deterministic behavior once or on a schedule.
---

Install Bun 1.3.14 or newer, then install the published CLI globally:

```sh
bun add --global @foundry/quirks
```

Ensure Bun's global binary directory is on your `PATH`. The command is `quirks`.
You do not need a project-local installation to run a configuration.

## Create one behavior

Save this as `quirks.config.ts` in the directory you want to inspect:

```ts
import { schedule, step } from "@foundry/quirks";

const inspect = step("inspect", async ({ workspaces, workspace }) => {
  const directory = await workspaces.add({ path: workspace.root });
  const { files } = await directory.refresh();
  return { files: files.length };
});

schedule("inspect-hourly", { workflow: inspect, input: null, at: "1h" });
```

The step catalogues files and returns their count. It makes no model calls and
does not require an installed agent harness.

## Run and inspect

```sh
quirks once inspect
quirks list
quirks status
quirks once inspect --dry
```

`once inspect` dispatches the step now. `--dry` still executes its ordinary code,
but does not save Quirks state. `list` shows the hourly schedule; declaring it
alone does not start a clock.

To dispatch that schedule now or keep it active in your terminal:

```sh
quirks once inspect-hourly
quirks run
```

Press Ctrl+C to stop the foreground loop. For scheduled processes on macOS,
continue to [launchd](/quirks/guides/launchd).

## Add judgment when it helps

With an installed, authenticated Claude Code or Codex CLI, add a retained agent:

```ts
import { agent } from "@foundry/quirks";

const guide = agent("workspace-guide", {
  prompt: "Explain this workspace. Ask before proposing changes.",
});

step("explain", async ({ agents, workspace }) => {
  const session = await agents.session(guide, {
    cwd: workspace.root,
    sessionId: "workspace-guide",
  });
  await session.generate("What should I understand about this workspace?");
  return { session: "workspace-guide" };
});
```

Run `quirks once explain`, then `quirks sessions`. The prompt supplies behavioral
instructions, not permissions. Read [safety and limits](/quirks/safety-and-limits)
before using agents on work you care about.

## Next steps

- [Concepts](/quirks/concepts) explains the five factories and their relationships.
- [Your first behavior](/quirks/guides/first-behavior) composes a small workflow.
- [CLI reference](/quirks/reference/cli) covers every command and flag.
