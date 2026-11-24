---
title: Docs drift watcher
description: When source files change, ask an agent which README and instruction statements are now untrue.
---

Code changes faster than the README. Every rename leaves a stale command
in `AGENTS.md` and a wrong flag in `docs/`. This watcher polls your source
every ten minutes. When files change, an agent compares them with the
documentation and lists each statement that is no longer true, with a
one-line fix. You get a Feed entry only when something drifted.

It uses three marbles: a file monitor, an agent with structured output,
and an artifact. You need an authenticated agent CLI, `zod`, and the
current source checkout for `monitor(...).name()`.

## The module

Save this as `.foundry/marbles/docs-drift.ts`:

<include>./_example/docs-drift.ts</include>

The monitor hands the changed paths to `docs-drift` by returning a locked
node with literal input. That launches the step as its own run, attributed
to the monitor. Returning `undefined` launches nothing.

The agent answers with an object that matches `drift`. Marbles validates it,
so the step counts stale statements instead of parsing prose. Each finding
lands in a new version of the **Docs drift** artifact, and the readable list
goes to the Feed.

## Run it

```sh
marbles list
marbles roll source
```

`list` shows `[monitor] source files src/**/*.ts every 10m`. `roll source`
polls once. The first poll has no baseline, so every matching file counts
as added and the agent audits the whole tree. After that, only changes
since the last poll reach it. Change the glob to match your layout.

Attach the workspace with `marbles attach` to keep it polling.

## Make it yours

- **Watch the instructions too.** Add a second monitor on
  `**/{AGENTS,CLAUDE}.md` that asks whether the instructions still match
  the code.
- **Queue fixes instead of reports.** Replace `report.artifact` with
  `tasks.create({ tags: ["factory"], ... })`, and the [Software
  Factory](/marbles/use-cases/software-factory) picks the fix up.
- **Keep it cheap.** Route the auditor to a smaller model with
  `auditor.extend({ model })`, or by quota as the [release
  patrol](/marbles/use-cases/release-patrol) does.
