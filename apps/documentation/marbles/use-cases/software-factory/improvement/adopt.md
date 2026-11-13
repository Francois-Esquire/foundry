---
title: Adopt changes and track results
description: Approve a specific improvement, retain the previous version, and check whether it helps in practice.
---

A passing evaluation supports a decision. The owner still chooses whether
to make the candidate active. Record the exact commit or artifact version,
the evidence considered, known gaps, and the person responsible for follow-up.

## Make adoption explicit

Code changes follow [Approve and deliver](/marbles/use-cases/software-factory/development/approve).
For prompts and skills, name the version to activate and where it is loaded.
Retain the previous version and a way to restore it. Marbles does not supply
an automatic promotion system for these instructions.

Module edits reload the workspace's worker on their own; restart the
Marbles process (`marbles stop`, then `marbles`) when cached directory-based
skills outside the authoring folder change.
For file-triggered skill trials, follow the
[snapshot rules](/marbles/use-cases/evaluations/skills#capture-the-skill-you-actually-tested)
so the evidence identifies the contents that were actually tested.

## Observe real work

Choose a follow-up window and sample before rollout. For a review skill,
inspect accepted findings, false alarms, missed defects, and human corrections
in the next agreed set of reviews. For a module change, inspect the next
change that exercises the responsibility you simplified.

Use [scheduled reports](/marbles/use-cases/software-factory/maintenance/automate)
to collect attention items and the [inspector](/marbles/use-cases/software-factory/improvement/inspector)
to interpret them. A schedule repeating successfully does not establish that
the improvement worked.

## Close or reopen the finding

Record whether the original failure recurred and whether the observed cost
changed. Keep, revise, or revert the candidate based on that evidence. If the
problem remains, reopen the finding with what you learned instead of erasing
the unsuccessful attempt.

The record now connects the initial weakness, proposed change, evaluation,
adoption decision, and observed result. Later inspections can build on it.
