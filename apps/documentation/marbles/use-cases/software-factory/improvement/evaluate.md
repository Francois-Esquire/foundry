---
title: Evaluate a proposed improvement
description: Compare the candidate with the current factory and check whether it fixes the observed weakness.
---

Begin with the original inspection finding and its proposed remedy. Decide
what would count as an improvement before running the comparison. Keep the
baseline, candidate, and evaluation evidence together in the improvement record.

## Choose evidence that answers the finding

| Proposed change | Evidence to compare |
| --- | --- |
| Simplify a module | Required results remain correct; callers no longer duplicate the targeted decision. |
| Improve a review skill | It catches the recorded defect and avoids new false alarms on clean cases. |
| Add a specialist reviewer | It contributes valid findings that the existing review misses, within the agreed cost. |
| Change a model or harness | It completes the same tasks with acceptable correctness, duration, and failure rates. |

Keep the fixture revision, scoring rules, and unchanged settings fixed. Use
fresh sessions for independent trials. Record failed trials and missing
evidence alongside successful results. Repeat variable tasks rather than
promoting a candidate on one favorable answer.

The [Evaluations](/marbles/use-cases/evaluations) section explains case design,
model and harness comparisons, and runnable skill checks. Use those mechanics
here; the factory-specific question is whether the change addresses this
inspection finding without unacceptable regressions.

## Review the comparison

Give the review lead the original finding, the patch, the test conditions,
raw results, and a short account of what improved or regressed. Require
evidence for claims about maintainability or review quality, not just a higher
aggregate score.

Classify the result as ready to adopt, needing another scoped revision, or
rejected with a reason. An unresolved question stays open. Keep earlier
attempts and stop when the revision budget is exhausted.

Next: [Adopt changes and track results](/marbles/use-cases/software-factory/improvement/adopt).
