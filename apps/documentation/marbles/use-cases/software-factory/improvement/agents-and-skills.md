---
title: Improve agents, prompts, and skills
description: Diagnose a recurring agent failure and propose a versioned change to the instructions or setup.
---

Use a recorded failure to decide what to change. An agent that missed a
requirement may have lacked the issue context, followed a stale skill, lacked
a needed tool, or made a poor judgment despite having what it needed.
Those causes call for different changes.

## Diagnose before rewriting

Read the task, transcript, selected skills, tool results, and human correction.
Record their versions. Check whether the skill was available and applied,
and whether the reviewer received the original request and implementation
explanation. An isolated comment on a diff is not enough context to assess
the whole process.

| Finding | Candidate improvement |
| --- | --- |
| Review lacks the original intent | Supply the issue, acceptance criteria, and implementation history. |
| Skill recommends an obsolete interface | Update that instruction and add a regression case. |
| Reviewers repeat one another | Give them distinct risks to assess and keep independent sessions. |
| Agent cannot perform the required check | Fix the environment or tool access and retest the task. |
| Findings have no supporting evidence | Require a location, triggering condition, and consequence. |

## Keep the candidate separate

Give the improvement agent the accepted finding and one proposed intervention.
Ask for a small patch with an explanation of how it addresses the failure.
Store the candidate prompt, skill, or workflow change on a branch; retain the
active version for comparison.

Record any changed tool permissions. Broader authority changes the setup
being evaluated and needs the owner's decision. Keep the revision budget
explicit so repeated failures end in a handoff.

## Test the deployed combination

Use the [skill evaluation guide](/marbles/use-cases/evaluations/skills) to test
the candidate alone and alongside the other skills normally selected. Include
known failures, normal work, and tasks where the skill should not apply.
The same checks apply to handwritten and agent-written skills.

Next: [Evaluate a proposed improvement](/marbles/use-cases/software-factory/improvement/evaluate)
ties that comparison to the inspector's original finding.
