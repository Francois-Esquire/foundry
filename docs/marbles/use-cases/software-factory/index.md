---
title: Software Factory
description: Understand the roles, records, and loops behind development, maintenance, and improvement.
sidebar:
  label: The factory floor
---

> This factory will not solve your engineering woes. Agents can do substantial
> work, but this guide keeps a human responsible for scope, engineering judgment,
> and delivery. Review the code and its evidence. Revisit that level of supervision
> as models improve and your own evaluations justify it.

The factory floor is the collection of workflows people operate. Start with
one repository and an owner who can resolve conflicting findings, stop work,
and decide what ships.

## Three kinds of work

| Category | Purpose | Start here |
| --- | --- | --- |
| Development | Implement an accepted request and verify the result. | [Take an issue](/marbles/use-cases/software-factory/development/intake). |
| Maintenance | Find drift, review ongoing work, and respond to incidents. | [Review existing pull requests](/marbles/use-cases/software-factory/maintenance/pull-requests). |
| Improvement | Reduce recurring problems in the codebase and the factory itself. | [Inspect the factory](/marbles/use-cases/software-factory/improvement/inspector). |

The categories cooperate. Maintenance may find that reviews keep missing a
particular defect. An inspector investigates why, then proposes a skill or
code change. The accepted change goes through evaluation and review before
adoption. Code changes use the development cycle.

## The base loop

```text
observe → gather context → assess → act within scope → check → record
                              ↑                         │
                              └── revise or hand off ───┘
```

An observation can be an issue, PR revision, failed check, changed skill, or
scheduled inspection. Record the source and its revision before dispatch.
Each stage returns evidence and a next action. Missing context calls for a
question; an unsuccessful attempt may need revision or a handoff.

One issue can take several runs. A completed run does not mean the issue is
finished. A maintenance run that finds no action necessary is also useful.

## Roles and decisions

| Role | Responsibility |
| --- | --- |
| Triage agent | Establish whether a request is understood and ready to plan. |
| Implementer | Make the scoped change and explain its decisions and checks. |
| Reviewer | Assess the exact candidate against its original intent. |
| Review lead | Reproduce findings, remove duplicates, and record disagreements. |
| On-call agent | Investigate an incident and hand evidence to its owner. |
| Inspector | Assess whether the factory's code, checks, and instructions still serve the project. |
| Improvement agent | Propose a change based on an accepted inspection finding. |
| Human owner | Set priorities, resolve disputed judgments, and authorize delivery. |

These are roles you author with agents and workflows, not built-in Marbles
roles. One person may cover several jobs. Give each agent a specific task,
the relevant context, and a stopping condition.

## Shared records

The [work log](/marbles/use-cases/software-factory/development/work-log)
preserves the request, implementation history, findings, and decisions. A
reviewer needs the original intent as well as the diff. An inspector needs
both accepted and rejected findings to assess review quality.

Keep separate records for an issue, a PR review, and an evaluation trial.
Link them by issue number, commit SHA, and artifact version ID. A run ID
identifies one execution; it is not the identity of the work itself.

[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
orders the steps, [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
performs model work, and [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md)
retains evidence. Human approvals name the exact candidate they authorize.

## Start locally

### Prerequisites

Complete [the quickstart](/marbles/get-started/quickstart). Development needs a
local Git repository, an authenticated GitHub CLI and agent CLI, and the
project's test commands. The [development setup](/marbles/use-cases/software-factory/development/intake#before-you-start)
lists the dependencies. Maintenance chapters state which helpers they reuse;
improvement needs recorded runs or review findings to inspect.

Choose a category above. Development contains the complete issue walkthrough.
Maintenance has separate examples for on-call work, monitoring, and reports.
Improvement guides an inspection through a reviewed change.

Start with manual launches. Add schedules after the workflow produces useful
results and ownership is clear. These examples use local state and do not
coordinate independent machines.

[Evaluations](/marbles/use-cases/evaluations) supplies reusable methods for
comparing models and skills. [Design](/marbles/use-cases/design) covers product
decisions and the implementation handoff.
