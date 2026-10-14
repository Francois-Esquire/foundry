---
title: Compare models and harnesses
description: Make controlled comparisons and keep failures, uncertainty, and operating cost visible.
---

Start with a question you can answer, such as whether a candidate finds more
real review defects without increasing false alarms. Changing the model,
prompt, skill set, and tool permissions together tests the whole setup. It
does not tell you which change helped.

## Freeze the comparison

Select a baseline and candidate. Pin the fixture revision, suite, and scoring
rules before running either. Record provider and model settings; some providers
may not support equivalent settings. A CLI provider also brings its own
instructions and tools, so describe comparisons across providers as comparisons
of complete setups.

Use a fresh session per trial. For code-writing tasks, create a fresh checkout
or [sandbox](/marbles/foundation/workspaces-and-sandboxes) and run the same
verification commands afterward. Keep expected answers and the grader outside
the candidate's accessible files when testing whether it can solve a task.

## Score the work

| Evidence | What it answers |
| --- | --- |
| Tests and required commands | Did the candidate meet the checked requirements? |
| Defects found and false alarms | Did the reviewer identify real problems without inventing new ones? |
| Human assessment | Is the code maintainable and appropriate for the original intent? |
| Duration and reported usage | What did the result cost to obtain? |
| Errors and timeouts | Could the setup complete the task within its budget? |

Keep errors in the denominator. Distinguish a provider outage from a wrong
answer, but do not silently discard failed trials. A repair attempt is another
trial with its own cost; an automatic workflow retry can hide that distinction.
The [durability guide](/marbles/foundation/durability) explains retry and replay.

Repeat cases when responses vary. Compare per-case regressions as well as the
overall score. Save transcripts and candidate revisions so a person can
inspect why a score changed. If a model grades the output, record its version
and rubric and check a sample of its judgments against human decisions.

## Decide whether to adopt

Set the acceptance rule before reading candidate results. For example, require
no regressions on critical cases and fewer unsupported review findings across
the suite, within an agreed runtime budget. Record the sample size and the
remaining gaps alongside the decision.

Keep the previous setup available. Changing a provider's default model can
change results even when your code is unchanged; record the resolved model
when available and schedule a periodic comparison. An alias alone is not an
immutable version.

The [skill example](/marbles/use-cases/evaluations/skills) runs a small local
comparison through the current CLI providers. Larger suites need their own
fixtures, isolated execution, and grading. Marbles does not include a model
leaderboard or automatic promotion policy.
