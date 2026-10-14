---
title: Evaluations
description: Compare models, harnesses, and skills against recorded tasks and explicit checks.
sidebar:
  label: The evaluation loop
---

An evaluation asks whether a specific change improves the work you need done.
Keep a baseline, run the candidate on the same cases, and preserve the evidence
for each result. Marbles supplies steps, sessions, artifacts, and triggers;
you supply the cases and the checks that judge them.

```text
record cases → run baseline and candidate → check results → inspect differences
                       ↑                                      │
                       └── propose one change and repeat ──────┘
```

## Decide what you are testing

| Subject | What changes | What stays fixed |
| --- | --- | --- |
| Model | The model identifier. | Harness, tasks, instructions, tools, and settings where supported. |
| Harness | Tool access, context handling, or execution environment. | Model and task set where possible. |
| Skill | Instructions, supporting files, or a selected set of skills. | Model, harness, fixtures, and scoring rules. |

A harness is the software that runs the model's conversation and tools.
A trial is one candidate executing one case. A suite is the collection of
cases and scoring rules. Use these names in reports so a "pass" has a clear
meaning.

## Start with cases you can judge

Use real failures alongside normal tasks and cases where no action is needed.
Each case needs an input, a starting revision or fixture, expected results,
and a time or cost budget. Keep held-out cases out of the examples used to
revise prompts and skills.

Prefer executable checks for observable results. Code should compile and
pass relevant tests; a review should identify the seeded defect and avoid
inventing one in the clean fixture. Use a person or a calibrated model judge
for qualities those checks cannot establish. Keep that judgment separate
from command exit codes.

## Keep enough evidence to compare

Record the case and suite versions, model and provider, harness version,
prompt and skill contents, settings, tool permissions, environment, output,
test results, elapsed time, and reported usage. Mark unavailable values as
unknown. Start each independent trial in a fresh session and reset any
files the previous trial could change.

[Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
provides sessions; [Models](https://github.com/Francois-Esquire/foundry/blob/main/packages/models/README.md)
resolves their routes. [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md)
keeps the trial records and comparisons.

Continue with [model and harness comparisons](/marbles/use-cases/evaluations/compare),
then [test a skill](/marbles/use-cases/evaluations/skills) and
[run checks when it changes](/marbles/use-cases/evaluations/watch).
