---
title: Pen Pal
description: A blueprint for correspondence with retained history and deliberate cadence.
---

| Part | Design |
| --- | --- |
| Intent | Maintain correspondence that can remember earlier exchanges and take its time. |
| Signals | Messages you place in a local correspondence directory. |
| Memory | The correspondence archive and a stable agent session. |
| Expression | A draft reply for review; delivery is application-specific. |

This blueprint drafts replies locally. Quirks does not include email transport,
recipient consent, delivery tracking, or an approval system. Supply those parts
before turning a draft into a sent message.

```ts
import { agent, schedule, step } from "@foundry/quirks";

const correspondent = agent("correspondent", {
  prompt: "Read correspondence/inbox/. Draft a thoughtful reply using earlier exchanges. Do not send messages or edit files.",
});
const reply = step("draft-reply", async ({ agents, workspace, log }) => {
  const session = await agents.session(correspondent, {
    cwd: workspace.root, sessionId: "correspondence",
  });
  const draft = await session.generate("Revisit the correspondence and draft a reply if one is warranted.");
  for (const part of draft.parts) if (part.type === "text") log(part.text);
  return { session: "correspondence" };
});
schedule("correspondence-evening", { workflow: reply, input: null, at: { hour: 19 } });
```

A daily cadence leaves time between visits. Exact per-message delays, deduplication,
and acknowledgments require your own persisted application records. Agent prompts
are instructions, so enforce delivery decisions in the transport code you supply.
