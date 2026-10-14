---
title: Take an issue
description: Choose a ready issue and define what a successful change must prove.
---

Development takes one accepted issue through planning, implementation, review,
and delivery. Follow these chapters in order to build the local workflow.

```text
issue → plan → implement → test and review → approve → publish
                  ↑              │
                  └── revisions ─┘
```

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

Run one writer per issue at a time. The sample uses local artifacts and Git
branches; it does not coordinate independent machines. Start manually,
then enable the schedules after the cycle works in your repository.

`marbles --dry-run list` checks that the definitions load. A dry run of the
workflow cannot exercise this cycle because it substitutes command output,
including the issue JSON and Git commit IDs that these steps require.

## Choose the issue

Choose one small GitHub issue. The issue needs a problem statement and
acceptance criteria that a reviewer can check. For example:

```md
## Problem
The README lists commands that no longer match package.json.

## Acceptance criteria
- [ ] Documented project scripts match package.json.
- [ ] A new contributor can install dependencies using the documented command.
- [ ] The README identifies the command that runs the test suite.
```

The example reads checkbox items under `## Acceptance criteria`. Existing
checkmarks do not waive verification. Each candidate must supply new evidence.

Read the issue before giving it to an agent:

```sh
gh issue view 42 --repo OWNER/REPOSITORY --json number,title,body,url,updatedAt,state
```

Replace the repository and issue number throughout the walkthrough. The
[GitHub CLI reference](https://cli.github.com/manual/gh_issue_view) lists the
available fields.

## Decide whether it is ready

If the request lacks a reproduction, intended behavior, or acceptance
criteria, clarify it in the issue first. Break unrelated requests into
separate issues. For scheduled discovery, add a `factory-ready` label only
after this review.

An incident can enter through [on-call](/marbles/use-cases/software-factory/maintenance/on-call)
before anyone knows the fix. Investigation should produce evidence and a
next action. Implementation starts once that work becomes a ready issue.

Next: [Keep a work log](/marbles/use-cases/software-factory/development/work-log) captures
this issue and gives every later stage the same record.
