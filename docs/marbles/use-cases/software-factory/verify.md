---
title: Test and review
description: Check a candidate against the original issue, plan, implementation, and previous findings.
---

Review starts with context. The reviewer reads the original issue,
acceptance criteria, plan, implementation explanation, previous attempts,
and test output. It then examines the exact candidate commit. A candidate
is the committed revision proposed for this issue, identified by its SHA.

Create `.foundry/marbles/_factory/verify.ts`:

<details>
<summary>Complete verify.ts</summary>

<include>./_example/_factory/verify.ts</include>

</details>

Replace `factory.ts` with:

<include>./_example/_verified.ts</include>

## Read the result

The verifier records install and test output even when a command fails.
It returns `verified` only when those commands pass, the review supplies
positive evidence for every criterion, and there are no review blockers.
Otherwise it returns `needs-changes`. That run completed its assessment;
it did not approve the code.

A model's assessment is evidence for the human decision. Adapt the commands
to the project's actual checks. A successful `bun test` cannot prove a
browser interaction that the suite never exercises.

## Keep review history

This is the persistent reviewer inside the factory. The work log stores
one review session reference per issue, so later attempts can revisit
unresolved findings. Each turn also receives the written history, including
the initial implementation. The transcript is not the only record.

Changing the checkout during verification rejects the evidence. Prompts
ask the agent to leave files alone; they do not enforce read-only access.
Use the [session controls](/marbles/reference/agent-sessions) appropriate
to your environment.

Next: [Revise the candidate](/marbles/use-cases/software-factory/revise).
