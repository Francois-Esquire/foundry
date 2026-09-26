---
title: Repository Caretaker
description: Detect instruction changes before asking for judgment.
---

This configuration observes instruction files. The monitor performs change
detection; an agent investigates what the change means in context.

```ts
import { agent, monitor } from "@foundry/quirks";

const caretaker = agent({
  prompt: "Investigate repository instruction drift and recent history. Report findings without editing.",
});

monitor("**/{AGENTS,CLAUDE}.md")
  .every("1m")
  .do(async ({ files, agents, report }) => {
    const session = await agents.session(caretaker);
    const reply = await session.generate(
      `Investigate these changes to the instruction files: ${JSON.stringify(files)}. Read git log for the commits that touched them.`
    );
    report.result({ title: "Instruction drift", body: reply.text });
  });
```

```sh
quirks list
quirks once <the monitor key list printed>
quirks
```

The first poll establishes a baseline and reports existing files as added;
later polls report `added`, `modified`, and `removed` with their digests. The
observation advances only after the handler resolves. The session runs in the
config's directory, so the agent can read `git log` itself; there is no
dedicated Git-history monitor, and the directory scanner does not look inside
`.git`.

A review prompt does not enforce read-only access. To keep a conversation
across polls, keep the session reference the way the
[persistent reviewer](/quirks/use-cases/persistent-reviewer) does.
