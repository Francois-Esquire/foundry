---
title: Primitives
description: The resources supplied to steps and monitor handlers.
---

The CLI binds a `Primitives` object after configuration registration.

| Field | Use |
| --- | --- |
| `models` | Model access through `models.model(model, provider, options)`. |
| `executors` | Selected, detected harness references in preference order. May be empty for deterministic work. |
| `workspaces` | Directory catalogue access and Git helpers. |
| `workspace.root` | Canonical config directory, or working directory without a config. |
| `agents.session(spec, options)` | Open an agent conversation using the runtime session store. |
| `sessions` | Disk-backed session storage in normal CLI execution; in memory under `--dry`. |
| `state` | This workspace's state directory, or `undefined` under `--dry`. |
| `log(message)` | Write a line through the CLI. |

Underlying Foundry model, session, workflow, and Git objects remain directly
accessible. Step bodies can import ordinary TypeScript libraries.

## Workspaces

```ts
import { step } from "@foundry/quirks";

step("inventory", async ({ workspaces, workspace }) => {
  const directory = await workspaces.add({ path: workspace.root });
  const { files } = await directory.refresh();
  const git = workspaces.git(workspace.root);
  return { files: files.length, git: await git.status() };
});
```

`add` returns a directory with the directory and Git extensions. The catalogue
is in memory. Quirks persists monitor snapshots and execution state separately;
adding a directory does not give it another Quirks state scope.

## Model turns and harnesses

Use the `ai` SDK when a turn does not need a retained Quirks conversation:

```ts
import { step } from "@foundry/quirks";
import { generateText } from "ai";

step("summarize", async ({ models, executors, workspace }) => {
  const executor = executors[0];
  if (!executor) throw new Error("No execution harness is available");
  const { text } = await generateText({
    model: models.model(executor.model, executor.provider, {
      workingDirectory: workspace.root,
    }),
    prompt: "Summarize this repository in three sentences.",
  });
  return { text };
});
```

Declare `ai` as a direct dependency in a project importing it. Quirks detects
`claude` and `codex` on `PATH`, preferring Claude Code when both are present.
Detection does not verify authentication. `--harness` filters that set. Model
and session operations need an available executor; deterministic work does not.
Dry model operations also use the selected detected executor references.

See [session options](/quirks/reference/factories#session-options) for retained conversations.

## Git and temporary worktrees

`workspaces.git(root)` returns a `Git` object rooted at the supplied directory.
`status()` returns one of:

- `{ kind: "none" }` when there is no Git working tree;
- `{ kind: "unavailable", reason }` when Git state cannot be read;
- `{ kind: "repository", branch, detached, paths }` for a repository.

Each changed path includes `path`, `staged`, `unstaged`, and `untracked`.

```ts
import { step } from "@foundry/quirks";

step("review-checkout", async ({ workspaces, workspace }) =>
  workspaces.git(workspace.root).withWorktree({ base: "main" }, async (worktree) => ({
    status: await worktree.status(),
  })),
);
```

`withWorktree({ base, branch?, home? }, body)` creates a checkout, runs the
callback, and attempts removal in `finally`. It defaults to the system temporary
directory and a detached checkout. Supplying `branch` creates a branch that is
not automatically removed with the worktree.

A `Worktree` supports its parent Git operations. It separates the checkout but
does not sandbox the callback or harness. Runtime-provided Git commands use echo
substitution under `--dry`; reads and temporary directory creation can still
occur. See [safety and limits](/quirks/safety-and-limits).
