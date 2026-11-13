---
title: Artifacts and results
description: Distinguish step results, readable reports, and versioned outputs that survive a run.
---

Choose an output by who needs it. Return data to a parent step, post a
report for a person, or write an artifact for later runs to read.

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

The [Software Factory work log](/marbles/use-cases/software-factory/development/work-log)
keeps the issue, plan, commits, findings, and human decisions in one artifact.
It also saves the [reviewer's session reference](/marbles/use-cases/software-factory/development/verify#keep-review-history).
[Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
owns that conversation; the artifact tells the next run which one to continue.

## Keep the result and its provenance

Inside a run, artifact metadata includes the owning run and session IDs.
Keep those references when tracing how an output was produced. Artifact
storage preserves the evidence you write; it does not verify its accuracy
or copy every file in a worktree automatically.

A returned value belongs to a particular run. An artifact has an identity
that later runs can find, with a specific version for the output they need.
A session reference identifies a conversation. These records serve different
purposes even when they all came from the same step.

Next: [Durability](/marbles/foundation/durability) brings those records
together to explain what happens when work waits, replays, retries, or is
interrupted.
