---
title: Workspaces and sandboxes
description: Choose where files, commands, agents, and isolated environments operate.
---

A workspace is a directory Marbles works with. A sandbox is an isolated
environment that can mount a workspace or start from a set of files. Their
definitions describe location and configuration; their instances expose
operations.

[Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md)
supplies project identity, file access, and Git capabilities.
[Sandbox](https://github.com/Francois-Esquire/foundry/blob/main/packages/sandbox/README.md)
supplies isolated file and command interfaces. Both use
[Core's storage contracts](https://github.com/Francois-Esquire/foundry/blob/main/packages/core/src/storage.ts);
Marbles adds the owning step's working directory, cancellation, and cleanup.

## The current workspace

With the default `.foundry/marbles/` authoring folder, the workspace is your
project root above `.foundry`. `workspaces.current` exposes that project:
`root`, `files()`, `read(id)`, and Git operations when it is a repository.

Selecting a custom source changes this resolution. See the
[project reference](/marbles/reference/project#the-workspace) for directory
and single-module rules.

Declare another directory with `workspace({ path: "../website" })`.
Relative paths resolve from the project root. The returned
`WorkspaceInstance` loads on use; `workspaces.load(definition)` gives you
an explicit handle. A directory selection provides context for work; it
does not restrict everything arbitrary TypeScript can access.

## Temporary Git worktrees

In a Git project with at least one commit, this complete module reads a
revision in a temporary checkout:

```ts
import { step } from "@foundry/marbles";

step("inspect-commit").do(({ workspaces, exec }) =>
  workspaces.current.git.withWorktree({ base: "HEAD" }, async (checkout) => {
    const result = await exec(["git", "rev-parse", "HEAD"]);
    return { revision: result.stdout.trim(), checkout: checkout.root };
  })
);
```

`marbles roll inspect-commit` returns the commit and temporary path. The
checkout is removed when the callback ends. Supplying a new `branch` keeps
that branch after cleanup; committed changes survive, but uncommitted work
in the temporary checkout is not a durable result.

Return the commit SHA when another step must use that exact code. For
reports or generated files, save an [artifact](/marbles/foundation/artifacts-and-results)
before cleanup. [Durability](/marbles/foundation/durability) preserves
recorded results; it does not preserve every temporary directory or keep a
sandbox guest alive across a host failure.

Commands and agent sessions opened inside the callback inherit the
checkout's working directory. The default sandbox mount does too. Raw
filesystem calls should use `checkout.root` explicitly;
`workspaces.current.root` continues to identify the original project.

## Sandboxes

The CLI uses the optional MicroSandbox adapter. A real sandbox needs
`microsandbox@0.6.18` resolvable from the Marbles installation and its native
runtime binaries. Follow the runtime's setup for your host; adding a
package to the automation project alone does not necessarily make it
resolvable from a separate global CLI installation.

This complete module uses the runtime once configured:

```ts
import { sandbox, step } from "@foundry/marbles";

const box = sandbox({ image: "docker.io/oven/bun:1-slim", mount: "." });

step("sandbox-version").do(async ({ exec }) => {
  const result = await exec(["bun", "--version"], { sandbox: box });
  return result.stdout.trim();
});
```

The declaration does not boot a container. Its first operation starts it.
Inside a step Marbles owns its lifetime, output, and cancellation. A sandbox
used outside a step must be closed by its caller or runtime.

The image form mounts the current working directory read/write at
`/workspace`; `mount` can also select a declared workspace. The files form,
`sandbox({ files: { "main.py": "print(1)" } })`, seeds files without a host
workspace mount. Host authentication directories are not automatically
mounted. Network access defaults to disabled; executable workspace mounts
require `executable: true`.

Sandbox `exec` returns the exit code even on failure. The step context's
`exec(argv, { sandbox })` checks it and fails the step unless `check: false`.

## Agents inside a sandbox

`agents.session(agent, { sandbox: box })` runs the coding harness inside
the sandbox. Session permission profiles and credentials are separate from
host-session options; do not combine a sandbox with `cwd`.

The [agent session reference](/marbles/reference/agent-sessions) covers
permissions, questions, child agents, and session continuity. Start with
host execution while learning Marbles, then add isolation where your task
needs it.
