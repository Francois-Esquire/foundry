---
title: Adjust the design
description: Use explicit design variables and evidence to guide each iteration.
---

A design lever is a variable you can change deliberately, such as content
density or the prominence of an action. Name the problem, choose a lever,
and state what improvement you expect. "Make it better" gives an agent no
useful way to decide when to stop.

| Lever | A question to test |
| --- | --- |
| Information order | Can a person find the next decision before reading secondary detail? |
| Density and spacing | Does the screen show enough work without making items hard to distinguish? |
| Typography and contrast | Can people read the content and distinguish hierarchy and states? |
| Navigation and disclosure | Can they reach the needed action without losing their place? |
| Feedback and motion | Is the result of an action clear, including while it is pending or fails? |

Choose the relevant lever, not every lever at once. Keep the product's visual
identity and unrelated decisions stable so the comparison means something.
When variables must change together, record that tradeoff.

## Run one iteration

1. Capture the baseline at the target viewport with representative content.
2. Write a hypothesis, such as "showing ownership beside severity will reduce
   the need to open each incident."
3. Ask the design agent for a focused candidate and an explanation.
4. Compare the same task and states in both versions. Test keyboard use,
   responsive layouts, and accessibility where the change affects them.
5. Record what a person observed and whether to keep, revise, or reject it.

An automated screenshot comparison can reveal that pixels changed. It cannot
establish that the new hierarchy is easier to understand. Keep visual checks,
interaction checks, and user observations as separate evidence.

## Keep critique in context

Give reviewers the brief, constraints, accepted flow, changed lever, and both
versions. Ask for findings tied to a task or state. A reviewer who has only
one screenshot cannot assess the whole journey.

Synthesize conflicting feedback before requesting another design. Record
the accepted change and the reason for declining other suggestions. Cap
iterations and ask the owner to resolve a stalled decision. The same
[review discipline](/marbles/use-cases/software-factory/pull-requests#synthesize-before-revising)
applies to code and design.

Next: [Build and review](/marbles/use-cases/design/deliver).
