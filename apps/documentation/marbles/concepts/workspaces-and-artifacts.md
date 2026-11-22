---
title: Workspaces, sandboxes, and artifacts
description: Choose where work runs, isolate it when needed, and keep what it produced after the checkout is gone.
sidebar:
  label: Workspaces and artifacts
---

A workspace is a directory Marbles works with. A Git worktree is a
throwaway checkout of one. A sandbox is an isolated environment that can
mount a workspace or start from a set of files. An artifact keeps the
files a run produced, with a version per write, after the checkout or
sandbox is gone.

The [execution context](/marbles/concepts/steps-and-workflows#step-execution) supplies a default
working directory. Choose another workspace or a temporary checkout when
the task needs a different set of files; add a sandbox when commands need
an isolated environment.

## The current workspace

With the default `.foundry/marbles/` authoring folder, the workspace is your
project root above `.foundry`. `workspaces.current` exposes that project:
`root`, `files()`, `read(id)`, and Git operations when it is a repository.
These capabilities come from [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md).

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
import { step } from "@foundry.sh/marbles";

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
reports or generated files, save an [artifact](#artifacts-and-the-feed)
before cleanup. Later steps need a result they can use after the temporary
environment has been removed.

Commands and agent sessions opened inside the callback inherit the
checkout's working directory. The default sandbox mount does too. Raw
filesystem calls should use `checkout.root` explicitly;
`workspaces.current.root` continues to identify the original project.

## Sandboxes

[Sandbox](https://github.com/Francois-Esquire/foundry/blob/main/packages/sandbox/README.md)
supplies the file and command interfaces. The CLI uses its optional
MicroSandbox adapter. A real sandbox needs
`microsandbox@0.6.18` resolvable from the Marbles installation and its native
runtime binaries. Follow the runtime's setup for your host; adding a
package to the automation project alone does not necessarily make it
resolvable from a separate global CLI installation.

This complete module uses the runtime once configured:

```ts
import { sandbox, step } from "@foundry.sh/marbles";

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

## Choose the environment for the task

| Need | Use |
| --- | --- |
| Read or change the current project | `workspaces.current` |
| Inspect or change a particular revision | A temporary Git worktree |
| Control the command environment and its access | A configured sandbox |

## Artifacts and the Feed

An artifact is a named output with versions. Keep reports, evidence files,
and saved state there so later runs can read them or refer to an exact version.
The Feed is the dashboard view where people read results and milestones,
answer questions, and make approvals.

Both persist. Feed entries also use artifact storage internally. In your
automation, the distinction is what you are keeping and who needs to read it.
A saved departure time needs no announcement. A morning briefing needs
readable results in the Feed and retained evidence for later use.

Marbles uses [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md)
for versioned outputs and feed storage. Its file trees share
[Core's storage vocabulary](https://github.com/Francois-Esquire/foundry/blob/main/packages/core/src/storage.ts)
with workspaces and sandboxes, so a result can retain files after the
environment that produced them is gone.

## Choose an output

| Form | Use it for | Lifetime |
| --- | --- | --- |
| `return { ... }` | JSON data consumed by a parent step or returned by the run. | Recorded with the run; finished results are reused when that run continues. |
| `artifact(...).write(...)` | Files or saved state another run must read. | A version under a stable artifact identity. Does not post a Feed entry. |
| `report.result({ title, body })` | A readable message for a person. | A persisted Feed entry, without a separately declared output artifact. |
| `report.artifact(definition, files, { body })` | A saved output with a readable Feed report. | A new artifact version and a Feed entry referencing that exact version. |

`report.artifact(...)` connects the two. Its `files` are the saved output;
its optional third argument supplies the Feed entry's title, body, and media.
The Feed does not automatically render those files. Supply `body` when the
reader needs findings or a summary rather than an entry containing only a title.

A temporary worktree path or sandbox handle is useful while the resource
is alive. Return a commit SHA or artifact version ID when a later step
needs evidence that outlives that resource.

## Save a versioned report

Save this complete module as `.foundry/marbles/inventory-report.ts`:

```ts
import { artifact, step } from "@foundry.sh/marbles";

const inventories = artifact({
  name: "Project inventory",
  type: "text/markdown",
});

step("inventory-report").do(async ({ workspaces, report }) => {
  const files = await workspaces.current.files();
  const body = `Found ${files.length} files.`;
  const version = await report.artifact(
    inventories,
    { "inventory.md": `# Project inventory\n\n${body}\n` },
    { body }
  );
  return {
    files: files.length,
    artifactId: version.artifactId,
    version: version.id,
  };
});
```

Run `marbles roll inventory-report`, then open the dashboard Feed. The
Feed shows the file count. The artifact retains `inventory.md`, and the
returned result identifies the output and its version. A subsequent run writes
another version of **Project inventory**, rather than declaring an
unrelated output.

Artifact identity is derived from the workspace and declared name. Keep
the name stable when later runs should find the same output. The default
artifact store is `~/.foundry/artifacts`, separate from the workspace's run
and session state. See the [storage layout](/marbles/reference/state#persisted-state).

## Read across runs

`await inventories.latest()` returns the current version with `text(path)`
and `bytes(path)` helpers, or `undefined` before the first write. A known
version ID identifies a specific result; `latest()` intentionally follows
the current version as new runs write.

A later step reads the artifact directly. It does not need to parse Feed
messages to recover the saved output. The
[morning report](/marbles/use-cases/productivity/morning-report#read-the-result)
uses this distinction for departure state, readable briefings, and evidence.

The [Software Factory](/marbles/use-cases/software-factory/verify) writes a
verification artifact for every candidate commit and hands its version id
to the approval step, so the person approving reads the evidence for that
exact commit.

## Keep the result and its provenance

Inside a run, artifact metadata includes the owning run and session IDs.
Keep those references when tracing how an output was produced. Artifact
storage preserves the evidence you write; it does not verify its accuracy
or copy every file in a worktree automatically.

A returned value belongs to a particular run. An artifact has an identity
that later runs can find, with a specific version for the output they need.
A session reference identifies a conversation. These records serve different
purposes even when they all came from the same step.

## Share across workspaces

Every run, session, and artifact belongs to the workspace that created it.
`marbles share <kind> <id> <dir>` shows a run, session, or artifact in
another registered workspace as well; `marbles unshare` stops showing it.
Neither copies or moves the resource. A sandbox container stays with the
workspace that started it.

Sharing an artifact records an `artifact.shared` fact, and unsharing one an
`artifact.unshared` fact, in the owning workspace. An observer of
`artifact` there receives them as `ArtifactShareEvent`:

```ts
import { artifact, observe } from "@foundry.sh/marbles";

observe(
  artifact,
  (fact) => {
    if (fact.type === "artifact.shared") {
      console.error(`${fact.artifactId} is now visible in ${fact.workspace}`);
    }
  },
  { name: "shares", types: ["artifact.shared", "artifact.unshared"] }
);
```

A share fact holds `id`, `at`, `type`, `artifactId`, and `workspace`, the id
of the other workspace. Only the owner's observers see it. Typed share
facts need the current source checkout. [Resources and
workspaces](/marbles/reference/state#resources-and-workspaces) covers the
storage and the `.marbles/` links.

Next: [Durability, approvals, and local state](/marbles/concepts/durability).
