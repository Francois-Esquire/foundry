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

const reader = agent({
  prompt: "Read fragments/ without editing. Suggest connections grounded in specific files. Avoid repeating earlier suggestions.",
});

const revisit = step("revisit").do(async ({ agents, report }) => {
  const session = await agents.session(reader);
  const reply = await session.generate("What unfinished ideas are worth looking at together this week?");
  report.result({ title: "This week's connections", body: reply.text });
  return session.ref;
});

schedule(revisit).at({ weekday: "sun", hour: 10 });
```

The schedule creates a reason to return. It does not establish which fragments
matter; that remains a judgment to inspect in the resulting suggestions. The
step returns its session reference so a run's record shows which conversation
it held; to continue that conversation next week, keep the reference the way
the [persistent reviewer](/quirks/use-cases/persistent-reviewer) does.
