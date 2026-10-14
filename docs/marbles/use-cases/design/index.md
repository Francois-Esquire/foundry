---
title: Design
description: Carry a product brief through wireframes, design iterations, implementation, and ongoing care.
sidebar:
  label: The lifecycle
---

Start with the task a person needs to complete. Keep that task visible while
the design changes, then carry the accepted decisions into implementation.
Marbles can organize the work and retain its evidence; a person still decides
whether the product is understandable and useful.

```text
brief → flow and wireframes → prototype → evaluate and adjust → implement
                                  ↑                              │
                                  └── usage and review evidence ──┘
```

## Prerequisites

Complete [the quickstart](/marbles/get-started/quickstart). Bring a product
brief, access to the design files, and a person responsible for design
decisions. Authenticate an agent CLI when adding drafting or critique.
The [token sync example](/marbles/use-cases/design/sync) also needs Figma access
and a local application repository; its setup lists the exact requirements.

## Build the record before the screen

Give the product change one record containing the audience, task, constraints,
existing design language, and the outcome you want to observe. Keep references,
screenshots, alternatives, and decisions in versioned artifacts. Each iteration
should explain what changed and why.

| Stage | Decision or evidence |
| --- | --- |
| [Brief and wireframes](/marbles/use-cases/design/wireframes) | The user journey, content order, and necessary states. |
| [Adjust the design](/marbles/use-cases/design/iterate) | A specific design variable, the reason to change it, and a comparison. |
| [Build and review](/marbles/use-cases/design/deliver) | An accepted design translated into a tested implementation. |
| [Keep tokens in sync](/marbles/use-cases/design/sync) | A proposed update when the shared design library changes. |

These chapters describe workflows to author with current Marbles tools.
The token sync chapter includes a complete integration example. Browser
resources are on the [roadmap](/marbles/roadmap); the CLI does not yet supply
a built-in browser primitive or a product design evaluator.

## Connect design to engineering

Use an [artifact](/marbles/foundation/artifacts-and-results) for the brief,
prototypes, and review evidence. Use agent sessions for drafting and critique,
and keep a human approval between the accepted design and implementation.
Pass the approved artifact version into a
[Software Factory issue](/marbles/use-cases/software-factory/development/intake), with
acceptance criteria that include interaction and visual review.

After delivery, collect actual task failures and user feedback. Turn them
into another bounded iteration with a recorded hypothesis. A scheduled check
can detect a changed file; it cannot decide whether a design helps its users
without the relevant evidence.
