---
title: The factory floor
description: Separate issue delivery from the ongoing work that keeps the repository and its automation useful.
---

The factory floor is the collection of workflows people operate. Start with
one repository and one owner who can stop work, resolve conflicting findings,
and decide what ships.

## The base loop

Every workflow needs an observation, enough context to assess it, a bounded
task, and a recorded result. A person decides what happens next when the
evidence is incomplete or the action needs approval.

```text
observe → gather context → assess → act within scope → check → record
                              ↑                         │
                              └── revise or hand off ───┘
```

An observation can be an issue, PR revision, failed check, changed skill,
or scheduled inspection. Record the source and its revision before dispatch.
The same item may need another run. Keep its identity across those runs.

## Delivery and maintenance

| Loop | Work | Result |
| --- | --- | --- |
| Delivery | Triage an issue, plan, implement, verify, revise, and deliver. | A reviewed change tied to acceptance criteria. |
| Maintenance | Review open PRs, investigate incidents, check stale instructions, and inspect recurring failures. | Findings, a handoff, or a proposed issue. |

Maintenance does not need to manufacture an implementation task on every
tick. A report that finds no action necessary is a valid result. When it
does find work, send the evidence through [issue intake](/marbles/use-cases/software-factory/intake).

## Give each role a job

| Role | Owns |
| --- | --- |
| Triage agent | Whether a request is understood and ready to plan. |
| Implementer | The scoped change, its explanation, and appropriate tests. |
| Reviewer | Findings against the exact candidate and its original intent. |
| Review lead | Reproducing findings, resolving duplicates, and recording disagreements. |
| On-call agent | Investigation and a timely handoff to the responsible person. |
| Inspector | Whether the factory's checks, instructions, and skills remain useful. |
| Improvement agent | A proposed change to code, prompts, or skills based on accepted findings. |
| Human owner | Priorities, disputed judgments, and permission to deliver. |

These are roles you author with agents and workflows, not built-in Marbles
roles. One person may cover several jobs. Give an improvement agent a
specific finding and an agreed scope; review its work through the same cycle.

## Pass records between roles

The [work log](/marbles/use-cases/software-factory/work-log) holds intent,
implementation history, and evidence. A reviewer should not have to guess
what the implementer was trying to do. An inspector needs both accepted and
rejected findings to tell useful checks from noisy ones.

Keep separate records for an issue, a PR review, and an evaluation trial.
Link them with issue numbers, commit SHAs, and artifact version IDs. A run ID
identifies one execution; it is not the identity of the work itself.

[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
orders the steps, [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
performs the model work, and [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md)
retains the evidence. Begin with manual launches, then add the
[patrol](/marbles/use-cases/software-factory/automate) once responsibilities
and stopping conditions are clear.
