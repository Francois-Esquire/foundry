---
title: Repository Caretaker
description: Detect instruction and Git history changes before asking for judgment.
---

This configuration observes instruction files and Git's local reference log.
The file monitor performs change detection; an agent investigates what the
change means in context.

```ts
import { join } from "node:path";
import { agent, monitor, type Change, type Primitives } from "@foundry/quirks";

const caretaker = agent("caretaker", {
  prompt: "Investigate repository instruction drift and recent history. Report findings without editing.",
});

const investigate = async ({ agents, workspace, log }: Primitives, change: Change) => {
  if (change.kind !== "files") return;
  const session = await agents.session(caretaker, {
    cwd: workspace.root, sessionId: "caretaker",
  });
  const reply = await session.generate(`Investigate these changes: ${JSON.stringify(change)}`);
  for (const part of reply.parts) {
    if (part.type === "text") log(part.text);
  }
};

monitor("instruction-changes", investigate, {
  glob: "**/{AGENTS,CLAUDE}.md", every: "1m",
});
monitor("history-changes", investigate, {
  root: join(import.meta.dirname, ".git/logs"), glob: "HEAD", every: "1m",
});
```

```sh
quirks once instruction-changes
quirks once history-changes
quirks run
```

Use this in a normal Git checkout where `.git` is a directory and the reference
log exists. Linked worktrees may store Git metadata elsewhere; configure their
actual source or use a custom Git query. There is no dedicated Git-history
monitor. The directory scanner normally excludes `.git`; choosing its logs
directory as a separate monitor root makes this source explicit. Use separate
session IDs or serialization if concurrent handlers must not share a conversation.

The first observation establishes a baseline and reports existing files as
added. A snapshot advances only after the handler succeeds. A review prompt
does not enforce read-only access.
