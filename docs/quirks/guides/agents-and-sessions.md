---
title: Give an agent continuity
description: Reuse one conversation across separate CLI invocations.
---

Install and authenticate Claude Code or Codex before running model turns. Quirks
detects `claude` and `codex` on `PATH`. Harness authentication belongs to those
CLIs.

```ts
import { agent, step } from "@foundry/quirks";

const reviewer = agent("project-reviewer", {
  prompt: "Review this repository without editing. Compare with earlier findings.",
});

step("review-project", async ({ agents, workspace }, request: string) => {
  const session = await agents.session(reviewer, {
    sessionId: "project-review",
    cwd: workspace.root,
  });
  const reply = await session.generate(request);
  return { text: reply.parts
    .flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") };
});
```

```sh
quirks once review-project --input '"Review the repository and remember unresolved findings."'
quirks once review-project --input '"Compare this revision with your earlier findings."'
quirks sessions
```

The second invocation loads the same conversation from disk. Inspect its reply
and the session's message count to see that continuity. The model may still miss
changes or misinterpret history.

The harness runs the agentic loop; Quirks decides where that loop belongs within
a larger behavior. Declaring `agent` does not start a conversation. Opening a
session with a stable ID connects the agent to retained messages.

Omit `sessionId` for a new conversation. Compaction is on by default and may
replace older history with a summary. Use `compaction: false` to disable it, or
partial settings to adjust it. `executor` selects a detected harness; `cwd`
sets its working directory. Neither a directory nor a review prompt enforces
read-only access.

See [session options](/quirks/reference/factories#session-options) and
[safety and limits](/quirks/safety-and-limits).
