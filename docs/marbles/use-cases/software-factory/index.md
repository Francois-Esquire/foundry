---
title: Software Factory
description: Build a local implementation, verification, and approval workflow in working stages.
sidebar:
  label: The workflow
---

This walkthrough turns a task into a committed branch, tests and reviews
that exact commit, and records a human decision with a report. Each chapter
adds a working stage to the same project.

[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
owns the execution tree; [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
keeps the implementer's and reviewer's conversations;
[Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md)
provides the checkouts; [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md)
keeps the final report. Marbles connects them into one run.

```text
task → implement → test and review → human decision → report
         branch       commit SHA       approval       artifact
```

The final result is a reviewed candidate and a recorded decision. Publishing
or merging it remains a separate action; the approval step does not merge.

These stage boundaries also provide [durability](/marbles/foundation/durability):
while approval waits, the run keeps the completed implementation and
verification results. The examples leave retries unconfigured. Enable them
only for steps whose commands and external effects can safely repeat.

## Before you start

- Complete [the quickstart](/marbles/get-started/quickstart).
- Use a local Git repository where you intend an agent to make changes.
  Start with a clean working tree and at least one commit.
- Install and authenticate Claude Code or Codex. Run it directly once to
  confirm access; Marbles detects it on `PATH`.
- Install `zod@4.4.3` in this project.
- For verification, use a project with a committed `bun.lock` and a working
  `bun test` command. Adapt the two verification commands for another stack.

This walkthrough uses local commands and Git worktrees. A sandbox runtime
is not required. The commands and agent tools run with your local authority;
see [safety and limits](/marbles/reference/safety).

## Build in order

| Chapter | Working result |
| --- | --- |
| [Implement a task](/marbles/use-cases/software-factory/implement) | A branch and the commit produced by an agent in a temporary worktree. |
| [Test and review](/marbles/use-cases/software-factory/verify) | Tests and review findings for that commit. |
| [Add human approval](/marbles/use-cases/software-factory/approve) | A dashboard decision and a versioned report containing the evidence. |
| [Automate subsequent runs](/marbles/use-cases/software-factory/automate) | A scheduled check of an existing revision, reusing the verifier. |

Helper modules live in `.foundry/marbles/_factory/`. The leading underscore
keeps them out of automatic discovery; importing them from `factory.ts`
registers their named steps. Each chapter tells you which file to add or
replace. Keep one version of each file.
