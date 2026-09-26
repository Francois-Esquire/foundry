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
import { agent, artifact, monitor } from "@foundry/quirks";

const editor = agent({
  prompt: "Study only approved writing in voice/. Cite examples for proposed voice notes. Do not edit the corpus.",
});
const voiceNotes = artifact({ name: "Voice notes", type: "text/markdown" });

monitor("voice/**/*.md")
  .every("1h")
  .do(async ({ files, agents, report }) => {
    const session = await agents.session(editor);
    const reply = await session.generate(`Review these corpus changes: ${JSON.stringify(files)}`);
    await report.artifact(voiceNotes, { "notes.md": reply.text });
  });
```

Each poll that finds a change adds a version to the same artifact, so the
proposals accumulate where they can be compared. Choose which proposals
become approved guidance before other agents use them. Your approved files
remain the source of truth; to give the editor memory of its earlier
proposals, keep its session reference the way the
[persistent reviewer](/quirks/use-cases/persistent-reviewer) does. Prompt
instructions do not enforce filesystem permissions.
