---
title: Plan the work
description: Record an implementation approach against the issue and its starting revision.
---

The planner reads the captured issue and a checkout of the starting commit.
It returns an approach, planned checks, and any questions that prevent implementation.
Those questions stop the workflow and remain in the work log. A plan with
no open questions moves the issue to `planned`; unresolved questions move
it to `blocked`.

Create `.foundry/marbles/_factory/plan.ts`:

<details>
<summary>Complete plan.ts</summary>

<include>../_example/_factory/plan.ts</include>

</details>

Replace `factory.ts` with:

<include>../_example/_planned.ts</include>

Run the workflow for the same issue and inspect `plan.approach`. If it
stops with questions, clarify the issue and run it again. The intake step
allows this while no implementation attempt has started.

The plan does not replace the acceptance criteria. The implementer receives
both, and the reviewer checks the result against the original request.
The [Agents library](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
provides the planning session; the step records its structured result.

Next: [Implement the issue](/marbles/use-cases/software-factory/development/implement).
