---
title: Monitor the factory
description: What the dashboard tells you about runs and usage, and what stays unpredictable.
---

Open `marbles` in the repository to watch the factory. This guide follows
the source checkout; use a checkout-built archive as described in
[release status](/marbles/library#release-status).

## What to look at

| Question | Where | What you see |
| --- | --- | --- |
| Is anything stuck or failing? | **Overview** | Counts of running, queued, waiting, failed, completed, and cancelled runs, the success rate, and median run and wait times. |
| Where is this issue now? | **Overview**, then a run | The run's live steps, which step is active or failed, and its log. `a` jumps to the active step, `e` to the failure. |
| Is it waiting for me? | **Feed** | Open questions and approvals, such as `factory-deliver`'s publication approval. Answer them here. |
| What did it cost? | **Overview** and **Catalog** | Tokens and estimated cost per run, per workflow, and per agent. Catalog totals cover runs started from each definition. |
| What happened, in order? | **Logs** | Every run's log lines and Marbles' own, filtered by level, source, or text. |

The [dashboard reference](/marbles/reference/cli#the-dashboard) lists every
tab and key. From a terminal or another agent, `marbles watch <runId>`
follows one run and the MCP server's `get_run` reads its status.

## Read the cost figures carefully

Marbles records each agent turn's tokens, duration, and model from what the
harness reports, and keeps it under the workspace's state. The usage ledger stays in local state. The cost is an estimate at the model's list price, marked `~`. It
is not your bill. If you run agents on a Claude Code or Codex subscription,
read it as a way to compare runs, not as a charge. A turn with no known price is counted as unpriced, never as zero.
Some turns cannot be tied to one run, and the totals say so ("may be
incomplete", "not recorded"). The
[usage rules](/marbles/reference/cli#the-dashboard) explain each note.

To see how much of a subscription is left before choosing a model, a step
can read [`usage`](/marbles/foundation/usage).

## What is predictable, and what is not

The structure is predictable. Steps run in the order the workflow says.
Commands report their exit codes. A person approves the exact commit before
anything is pushed. Completed step results are reused when a run continues,
and a run parked on a question survives a restart.

The agents' work is not. The same issue can produce a different plan, a
different change, and different review findings on each run. The number of
turns, the duration, and so the cost vary with the model, the repository,
and the attempt. A review can miss a defect or report one that is not
there. A step that was in the middle of its body when the process stopped is
not resumed; its run is not adopted after a restart.

So bound what you can, and look at the rest:

- The example factory caps attempts per issue (`maxAttempts` in
  `_factory/record.ts`) and keeps publication behind an approval.
- Bound MCP agent dispatches with `timeoutMs`. `maxTurns` depends on the
  provider; see [agent options](/marbles/reference/mcp#agent-options).
- Compare the Overview's median run time and the Catalog's cost per
  workflow over several issues before you schedule anything.
- Check the evidence in the work log, not only the run's status. A completed
  run means the steps finished, not that the change is right.
