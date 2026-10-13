---
title: Repository Caretaker
description: Detect instruction changes before asking for judgment.
---

This module observes instruction files. The monitor performs change
detection; an agent investigates what the change means in context.

## Before you start

You need the [installed CLI](/marbles/get-started/installation), an authenticated Claude Code or Codex CLI and a project with matching instruction files.
Save the module below as `.foundry/marbles/repository-caretaker.ts` in your project.

## Write the automation

```ts
import { agent, monitor } from "@foundry/marbles";

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

## Run and verify

Copy the key printed by `list` into the placeholder before running:

```sh
marbles list
marbles roll <monitor-key>
marbles
```

The first poll establishes a baseline and reports existing files as added;
later polls report `added`, `modified`, and `removed` with their digests. The
observation advances only after the handler resolves. The session runs in the
workspace root, so the agent can read `git log` itself; there is no
dedicated Git-history monitor, and the directory scanner does not look inside
`.git`.

To keep a conversation across polls, keep the session reference the way the
[persistent reviewer](/marbles/use-cases/persistent-reviewer) does.

Open `marbles`, press Enter, and inspect the **Instruction drift** result in
the Feed. Edit a matching instruction file and wait for the next poll to
see a new investigation. The read-only prompt is an instruction, not a
filesystem permission boundary.
