---
title: Composition
description: Reuse small definitions inside larger graphs.
---

`step` returns a reusable unit of work. `workflow` returns a graph that can also
be used as a node in another graph. Input mappers connect the workflow input and
earlier node outputs to the next operation.

Start with named steps and mapped outputs. Add concurrency only when the work
can happen independently.

| Graph operation | Use |
| --- | --- |
| `step` | Place a step or workflow at a named node. |
| `sequence` | Chain definitions in order. |
| `parallel` | Run named branches and collect their results. |
| `race` | Select the first completed branch. |
| `branch` | Choose between two definitions using a predicate. |
| `output` | Select the graph's returned value. |

`loopUntil` wraps a definition in bounded repetition. It returns the last output,
the number of rounds, and whether its stopping predicate succeeded. Exhausting
the round limit does not mean the work passed verification.

Deterministic and agentic steps use the same graph. An implementation turn can
be followed by a test command, then a review turn. Make actual test results part
of the stopping condition when correctness depends on them.

Continue with [a working graph](/quirks/guides/workflows), or see the
[exact combinator shapes](/quirks/reference/factories#workflowname-define).
