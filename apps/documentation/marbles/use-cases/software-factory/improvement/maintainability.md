---
title: Improve code maintainability
description: Turn an observed maintenance cost into a scoped code change with evidence before and after.
---

Start with a finding from the [inspector](/marbles/use-cases/software-factory/improvement/inspector).
Name the cost it exposes, such as fixing the same rule in several modules or
changing many callers to add one supported case. Code age and personal taste
are weak reasons for a rewrite.

## Find the responsibility

Read the affected module, its callers, and its tests at a recorded revision.
Ask what callers must know to use it correctly, including errors, ordering,
and configuration. A useful improvement puts shared decisions behind a small
interface and keeps their implementation in one place.

Check domain names and invariants as well. If two modules use the same word
for different things, clarify that distinction before extracting shared code.
Do not create a package merely to move files. Identify who will use and own
its interface.

## Propose one change

Create an issue containing the finding, affected callers, intended result,
and checks that will establish it. For example, if three importers each
implement the same path rules, propose one module that owns those rules and
test it through the interface its callers use.

Record the observable results that must remain stable. Separate a structural change
from a new product requirement so reviewers can judge each one. Keep a larger
migration in independently reviewable steps with a clear stopping point.

## Use the development cycle

Send the accepted issue through [planning](/marbles/use-cases/software-factory/development/plan),
implementation, and review. Ask the reviewer whether the change actually
removed duplicated knowledge or made callers simpler. Moving the same
complexity into several new abstractions does not establish an improvement.

Keep the original finding in the work log. It becomes the basis for
[evaluation](/marbles/use-cases/software-factory/improvement/evaluate)
and the later check that the maintenance cost decreased.

For instruction changes, continue with
[Improve agents, prompts, and skills](/marbles/use-cases/software-factory/improvement/agents-and-skills).
