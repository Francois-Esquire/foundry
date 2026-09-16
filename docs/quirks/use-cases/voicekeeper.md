---
title: Voicekeeper
description: A blueprint for carrying approved writing decisions into future critique.
---

| Part | Design |
| --- | --- |
| Intent | Help an author preserve their actual voice across drafts. |
| Signals | Approved writing and edits stored under `voice/`. |
| Memory | Source files plus a retained conversation about observed choices. |
| Expression | A proposed voice note for human review. |

This blueprint needs your approved corpus and a policy for accepting new notes.
It does not infer consent or treat every draft as an example to imitate.

```ts
import { agent, monitor } from "@foundry/quirks";

const editor = agent("voice-editor", {
  prompt: "Study only approved writing in voice/. Cite examples for proposed voice notes. Do not edit the corpus.",
});

monitor("voice-notes", async ({ agents, workspace, log }, change) => {
  const session = await agents.session(editor, {
    cwd: workspace.root, sessionId: "voice-notes",
  });
  const reply = await session.generate(`Review these corpus changes: ${JSON.stringify(change)}`);
  for (const part of reply.parts) if (part.type === "text") log(part.text);
}, { glob: "voice/**/*.md", every: "1h" });
```

Choose which proposals become approved guidance before other agents use them.
The session is a working conversation; your approved files remain the source of
truth. Prompt instructions do not enforce filesystem permissions.
