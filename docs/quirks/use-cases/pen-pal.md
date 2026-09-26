---
title: Pen Pal
description: A blueprint for correspondence with retained history and deliberate cadence.
---

| Part | Design |
| --- | --- |
| Intent | Maintain correspondence that can remember earlier exchanges and take its time. |
| Signals | Messages you place in a local correspondence directory. |
| Memory | The correspondence archive and a retained agent session. |
| Expression | A draft reply for review; delivery is application-specific. |

This blueprint drafts replies locally. Quirks does not include email transport,
recipient consent, delivery tracking, or an approval system. Supply those parts
before turning a draft into a sent message.

```ts
import { agent, schedule, step } from "@foundry/quirks";

const correspondent = agent({
  prompt: "Read correspondence/inbox/. Draft a thoughtful reply using earlier exchanges. Do not send messages or edit files.",
});

const draftReply = step("draft-reply").do(async ({ agents, ask, report }) => {
  const session = await agents.session(correspondent);
  const draft = await session.generate("Revisit the correspondence and draft a reply if one is warranted.");
  report.result({ title: "Draft reply", body: draft.text });
  const { approved, note } = await ask.approval({ title: "Send this reply?", body: draft.text });
  return { approved, note, draft: draft.text };
});

schedule(draftReply).at({ hour: 19 });
```

A daily cadence leaves time between visits. The approval parks the run until
someone decides in the dashboard; it survives a quit and is answered from the
next one. A schedule that fires while no dashboard is open cancels the run at
the ask, so keep the dashboard open in the evening, or launch the step from
it. Sending remains the transport code you supply, driven by `approved`.
Exact per-message delays, deduplication, and acknowledgments require your own
persisted application records.
