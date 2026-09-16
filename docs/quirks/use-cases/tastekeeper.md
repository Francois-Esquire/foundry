---
title: Tastekeeper
description: A blueprint for preserving creative decisions as context for later critique.
---

| Part | Design |
| --- | --- |
| Intent | Help a critique reflect decisions already made, including deliberate rejections. |
| Signals | Accepted and rejected examples with the reasons recorded beside them. |
| Memory | Decision files and a retained critique session. |
| Expression | A comparison of a new proposal against those decisions. |

This blueprint needs a curated `decisions/` archive and proposal files. Treat
changed preferences as new evidence rather than asking the model to enforce an
unchanging taste profile.

```ts
import { agent, step } from "@foundry/quirks";

const critic = agent("taste-critic", {
  prompt: "Read decisions/ and cite accepted and rejected examples in critiques. Distinguish recorded preferences from your inference. Do not edit files.",
});
step("critique", async ({ agents, workspace }, proposal: string) => {
  const session = await agents.session(critic, {
    cwd: workspace.root, sessionId: "creative-decisions",
  });
  const reply = await session.generate(`Critique this proposal: ${proposal}`);
  return { text: reply.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") };
});
```

Use `quirks once critique --input '"Review proposals/poster.md"'` after supplying
your files. Accepting a critique and changing the decision archive remain
separate actions under your control.
