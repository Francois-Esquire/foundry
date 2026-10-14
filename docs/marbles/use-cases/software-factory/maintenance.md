---
title: Watch maintenance signals
description: Turn repository drift and upstream releases into evidence for new issues.
---

Repository care and release watching feed the same intake process. Each
monitor records a signal and an assessment. A person decides whether it
warrants an issue, adds acceptance criteria, and marks the issue ready.

## Watch repository instructions

The first monitor below watches `AGENTS.md` and `CLAUDE.md`. It asks an agent
to read the changed instructions and relevant Git history, then stores its
findings in an artifact. This is the repository caretaker's role in the factory.

## Watch upstream releases

The second monitor polls Bun's release metadata. It compares release tags
before asking for an assessment, so unrelated metadata changes do not
repeat the agent work. Change the source for another dependency.

Create `.foundry/marbles/maintenance.ts`:

<details>
<summary>Complete maintenance.ts</summary>

<include>./_example/maintenance.ts</include>

</details>

## Bring a signal into the cycle

Run `marbles list` to find each monitor key, then `marbles roll <key>` for
one poll. The first poll sees the existing files or release as a change.
Read the assessment in the Feed before enabling the monitor loop.

When an assessment warrants work, create or update an issue with the
source, artifact version, relevant findings, and acceptance criteria.
For a release, include the release tag. For instruction drift, identify
the changed files and repository revision. That evidence becomes part of
the issue snapshot and stays available to the implementer and reviewer.

The `Factory maintenance signals` artifact keeps a version per assessment.
Its latest version is the most recent signal, so retain the specific
version ID in the issue. It is not a queue of all unhandled signals.

A failed handler can observe the same change again. Check for an existing
issue before filing another one. Dry execution still reads files and sends
the HTTP request, while it substitutes the agent turn.

Next: [Schedule updates and reports](/marbles/use-cases/software-factory/automate).
