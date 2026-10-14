---
title: Implement the issue
description: Create the candidate branch and preserve the first implementation and every revision.
---

Implementation uses the issue, accepted scope, plan, and work log. The agent
works in a temporary checkout and commits its changes. The step records the
commit and the agent's explanation before removing that checkout.

The plan should identify any new package or dependency before implementation.
Prefer an existing module when it already owns the work. If inspection
reveals a missing dependency or a larger change, record the reason and resolve
the scope before proceeding. Include that decision in the implementation
explanation so reviewers can check it against the original request.

Create `.foundry/marbles/_factory/implement.ts`:

<details>
<summary>Complete implement.ts</summary>

<include>./_example/_factory/implement.ts</include>

</details>

Replace `factory.ts` with:

<include>./_example/_implemented.ts</include>

Run the same issue again, then inspect the returned commit with
`git show <revision>`. Its branch is `marbles/issue-<number>`.

[Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md)
provides the temporary checkout. Commits remain on the branch after cleanup;
uncommitted edits do not. A failed attempt records a blocked state and may
leave a branch that needs inspection. Do not delete it and retry blindly.

The first implementation stays in the chronicle when later attempts add
commits. A revision starts from the recorded candidate, checks that the
branch has not moved, and preserves the original base and plan. Every
attempt invalidates the earlier verification and publication decision.

Next: [Test and review](/marbles/use-cases/software-factory/verify).
