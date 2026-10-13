---
title: Artifacts and results
description: Distinguish step results, readable reports, and versioned outputs that survive a run.
---

A step returns data to its parent. A report makes an outcome visible to a
person. An artifact keeps an output under a stable name with versions that
later runs can read. Choose the form according to who needs the result.

Marbles uses [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md)
for versioned outputs and feed storage. Its file trees share
[Core's storage vocabulary](https://github.com/Francois-Esquire/foundry/blob/main/packages/core/src/storage.ts)
with workspaces and sandboxes, so a result can retain files after the
environment that produced them is gone.

## Three ways to keep an outcome

| Form | Use it for | Lifetime |
| --- | --- | --- |
| `return { ... }` | JSON data consumed by a parent step or returned by the run. | Recorded with the run; finished results are reused when that run continues. |
| `report.result(...)` | A readable message in the dashboard Feed. | Kept in feed storage for people to inspect. |
| `artifact(...).write(...)` or `report.artifact(...)` | Files, reports, or small state another run must read. | A version under a stable artifact identity. `report.artifact` also posts it to the Feed. |

A temporary worktree path or sandbox handle is useful while the resource
is alive. Return a commit SHA or artifact version ID when a later step
needs evidence that outlives that resource.

## Save a versioned report

Save this complete module as `.foundry/marbles/inventory-report.ts`:

```ts
import { artifact, step } from "@foundry/marbles";

const inventories = artifact({ name: "Project inventory", type: "text/markdown" });

step("inventory-report").do(async ({ workspaces, report }) => {
  const files = await workspaces.current.files();
  const version = await report.artifact(inventories, {
    "inventory.md": `# Project inventory\n\nFound ${files.length} files.\n`,
  });
  return { files: files.length, artifactId: version.artifactId, version: version.id };
});
```

Run `marbles roll inventory-report`, then open the dashboard Feed. The
result identifies the output and its version. A subsequent run writes
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

The [Persistent Reviewer](/marbles/use-cases/persistent-reviewer) stores a
small session reference in an artifact. [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
owns the conversation behind that reference; the artifact tells the next
run which conversation to continue. In the [Software Factory](/marbles/use-cases/software-factory/approve),
the artifact instead keeps the reviewed commit, findings, and human decision.

## Versions and replay

A managed artifact write inside a step records the version it produced.
When that step replays after a question or pause, the same call position
returns that version. A retry after failure is a fresh attempt and can
write another version. A new run also performs new writes. See
[Durability](/marbles/foundation/durability#replay-is-different-from-retry).

Inside a run, artifact metadata includes the owning run and session IDs.
Keep those references when tracing how an output was produced. Artifact
storage preserves the evidence you write; it does not verify its accuracy
or copy every file in a worktree automatically.
