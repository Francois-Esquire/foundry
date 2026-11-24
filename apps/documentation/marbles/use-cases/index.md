---
title: Use Cases
description: Blueprints built from a few marbles each, from a docs watcher to a full software factory.
sidebar:
  label: Overview
---

Each blueprint combines a few marbles you already know. Start with one
that solves a problem you have this week, run it by hand with `marbles
roll`, and leave it hosted once its results are useful.

| Blueprint | What it does | Marbles |
| --- | --- | --- |
| [Docs drift watcher](/marbles/use-cases/docs-drift) | Flags README and instruction statements a code change made untrue. | `monitor`, structured agent output, `report.artifact` |
| [Release patrol](/marbles/use-cases/release-patrol) | Turns upstream releases into upgrade tasks. | HTTP `monitor`, `agent(name, fn)` routed by `usage`, `tasks` |
| [Evaluations](/marbles/use-cases/evaluations) | Compares models, harnesses, and skills on recorded cases. | Sessions, structured output, artifacts, a file monitor |
| [Design](/marbles/use-cases/design) | Carries a brief through wireframes, iterations, and token sync. | Artifacts, agent critique, approvals, an HTTP integration |
| [Productivity](/marbles/use-cases/productivity) | Builds a morning briefing from GitHub, Slack, and Google Docs. | An agent with its CLI's MCP servers, artifacts, a calendar schedule |
| [Software Factory](/marbles/use-cases/software-factory) | Takes a task from intake to an approved pull request, with a revision loop. | `tasks`, `observe`, `.launch()`, worktrees, `.parallel`, `ask.approval`, `runs` |

The blueprints share their parts. A release patrol can tag its tasks
`factory` and hand them to the Software Factory. A docs drift finding can
become a task. An evaluation tells you whether a new reviewer prompt is an
improvement before the factory uses it.

Blueprints that use `.launch()`, `runs`, `agent(name, fn)`, or
`monitor(...).name()` need the current source checkout; see
[installation](/marbles/get-started/installation#install-the-package).
