---
title: Inspect the factory
description: Check whether code maintenance, agents, and skills are producing useful results.
---

The inspector reviews the process using recent evidence. A code reviewer
asks whether one candidate is sound. The inspector asks why the same defect
keeps escaping, why a check stopped catching it, or why a skill now recommends
an interface the repository no longer uses.

## Start with a bounded inspection

Pick one module or one recurring failure. Give the inspector the current
revision, relevant instructions and skill versions, recent work logs, test
results, and a sample of accepted and rejected review findings. Include a
known-good change so the inspector can detect false alarms.

| Check | Evidence to examine |
| --- | --- |
| Code freshness | Changed interfaces, obsolete examples, unused dependencies, and checks that no longer exercise the intended path. |
| Maintainability | Duplicated decisions, knowledge spread across callers, unclear ownership, and tests coupled to implementation details. |
| Agent usefulness | Missed defects, unsupported findings, repeated revisions, and human corrections. |
| Skill usefulness | Whether the skill was applied, whether its instructions still fit, and whether its outputs pass the agreed evaluation. |

Old code is not automatically stale. Name the changed assumption or observed
failure before proposing a rewrite.

## Write an inspection report

Store the inspected revision and evidence references in an artifact. Each
finding should contain the observed failure, its consequence, a reproducible
check, and the smallest proposed intervention. Mark missing evidence explicitly.

For example, an inspector may find that a review skill keeps recommending a
new package even though the repository already provides the same operation.
The proposed intervention is a skill change plus a regression case, with a
comparison against the current skill.

An inspection prompt can state:

```text
Inspect the supplied revision and run records. Read the current repository
instructions before assessing them. Separate code defects, stale checks,
instruction problems, and model failures. For each finding, cite the record
or file and explain the observed consequence. Do not infer failure from age
alone. Propose one testable improvement. Do not edit code or skills.
```

A prompt sets the task. [Session controls](/marbles/reference/agent-sessions)
and the chosen environment determine what the agent can actually access.

## Close the improvement loop

1. A person accepts, rejects, or requests more evidence for the finding.
2. An improvement agent proposes a scoped patch on a separate branch.
3. Code changes use the delivery loop. Prompt and skill changes use
   [evaluations](/marbles/use-cases/evaluations/skills).
4. The owner reviews the comparison and records which version to adopt.
5. A later inspection checks whether the original failure recurred.

Keep the failed examples and the previous version. A higher score on a
single case does not establish an improvement across the repository.

Run inspections on a schedule or after instruction changes. Bound the sample
size, model calls, and revision attempts. [File monitors](/marbles/use-cases/evaluations/watch)
can trigger a test when a skill changes; the inspector interprets its results.
