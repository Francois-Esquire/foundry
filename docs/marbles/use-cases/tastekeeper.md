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
import { agent, step } from "@foundry/marbles";
import { z } from "zod";

const critic = agent({
  prompt: "Read decisions/ and cite accepted and rejected examples in critiques. Distinguish recorded preferences from your inference. Do not edit files.",
});

step("critique")
  .describe("Compare a proposal with the recorded decisions.")
  .input(z.object({ proposal: z.string().describe("A file or a description") }))
  .output(z.string())
  .do(async ({ input: { proposal }, agents }) => {
    const session = await agents.session(critic);
    return (await session.generate(`Critique this proposal: ${proposal}`)).text;
  });
```

Use `marbles roll critique --input '{"proposal":"proposals/poster.md"}'` after
supplying your files, or launch it from the dashboard, where the schema
becomes a one-field form. Accepting a critique and changing the decision
archive remain separate actions under your control.
