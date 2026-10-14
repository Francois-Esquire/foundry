---
title: Software Factory
description: Take an issue through implementation, review, delivery, and ongoing care.
sidebar:
  label: The cycle
---

The factory starts with an issue. Its work log follows the issue across runs,
so each stage knows what was requested, what changed, and what still needs work.

```text
issue → plan → implement → test and review → approve → pull request → merge and close
                  ↑              │
                  └── revisions ─┘

on-call incidents and maintenance signals → issue intake
```

One issue can take several runs. Tests can fail, a reviewer can request a
change, or a person can decline publication. Those outcomes stay in the log.
A completed run does not mean the issue is finished.

## Before you start

- Complete [the quickstart](/marbles/get-started/quickstart).
- Use a clean local Git clone with an `origin` on GitHub. The sample publishes
  branches to that repository, so use one where you have permission to push.
- Install and authenticate `gh`, plus Claude Code or Codex. Confirm that
  `gh repo view` identifies this checkout and Git can fetch and push `origin`.
- Install `zod@4.4.3` in the automation project.
- Use a project with a committed `bun.lock` and a working `bun test` command.
  Change the verifier's commands for another stack.

The first example uses GitHub Issues. Each helper lives under
`.foundry/marbles/_factory/`; the launch modules beside that folder import it.
Follow the chapters in order and replace `factory.ts` where instructed.
Expand each complete module to copy its source; the short launch modules
stay visible so you can follow the workflow.

## Build the cycle

| Chapter | Result |
| --- | --- |
| [Take an issue](/marbles/use-cases/software-factory/intake) | A concrete request with acceptance criteria. |
| [Keep a work log](/marbles/use-cases/software-factory/work-log) | An issue snapshot and a versioned artifact that later stages update. |
| [Plan the work](/marbles/use-cases/software-factory/plan) | An approach grounded in the repository, or questions that stop the work. |
| [Implement the issue](/marbles/use-cases/software-factory/implement) | A committed branch and an explanation of the changes. |
| [Test and review](/marbles/use-cases/software-factory/verify) | Evidence for each criterion, with the original implementation in view. |
| [Revise the candidate](/marbles/use-cases/software-factory/revise) | Another attempt on the same branch, with a three-attempt limit. |
| [Approve and deliver](/marbles/use-cases/software-factory/approve) | A decision on an exact commit, a pull request, and observed completion. |
| [Run an on-call shift](/marbles/use-cases/software-factory/on-call) | Incident investigation, ownership, acknowledgement, and handoff. |
| [Watch maintenance signals](/marbles/use-cases/software-factory/maintenance) | Repository and release changes that may warrant a new issue. |
| [Schedule updates and reports](/marbles/use-cases/software-factory/automate) | Fresh remote refs, issue status, on-call attention, and a recurring report. |

Run one writer per issue at a time. The sample uses local artifacts and Git
branches; it does not coordinate independent machines. Start manually,
then enable the schedules after the cycle works in your repository.

`marbles --dry-run list` checks that the definitions load. A dry run of the
workflow cannot exercise this cycle because it substitutes command output,
including the issue JSON and Git commit IDs that these steps require.
