---
title: Take an issue
description: Choose a ready issue and define what a successful change must prove.
---

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

An incident can enter through [on-call](/marbles/use-cases/software-factory/on-call)
before anyone knows the fix. Investigation should produce evidence and a
next action. Implementation starts once that work becomes a ready issue.

Next: [Keep a work log](/marbles/use-cases/software-factory/work-log) captures
this issue and gives every later stage the same record.
