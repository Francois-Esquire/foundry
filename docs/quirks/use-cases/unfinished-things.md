---
title: The Unfinished Things
description: A blueprint for returning to fragments without forcing them into a task queue.
---

| Part | Design |
| --- | --- |
| Intent | Revisit dormant fragments and notice relationships worth pursuing. |
| Signals | Notes, sketches, and project fragments you deliberately make available. |
| Memory | Original fragments and a session retaining previous suggestions. |
| Expression | A short set of connections with links to their sources. |

This blueprint assumes a curated `fragments/` directory. It needs your choices
about privacy, relevance, and which suggestions deserve follow-up.

```ts
import { agent, schedule, step } from "@foundry/quirks";

const reader = agent("fragment-reader", {
  prompt: "Read fragments/ without editing. Suggest connections grounded in specific files. Avoid repeating earlier suggestions.",
});
const revisit = step("revisit", async ({ agents, workspace, log }) => {
  const session = await agents.session(reader, {
    cwd: workspace.root, sessionId: "fragments",
  });
  const reply = await session.generate("What unfinished ideas are worth looking at together this week?");
  for (const part of reply.parts) if (part.type === "text") log(part.text);
  return { session: "fragments" };
});
schedule("weekly-fragments", { workflow: revisit, input: null, at: { weekday: "sun", hour: 10 } });
```

The schedule creates a reason to return. It does not establish which fragments
matter; that remains a judgment to inspect in the resulting suggestions.
