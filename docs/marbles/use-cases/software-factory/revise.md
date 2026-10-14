---
title: Revise the candidate
description: Carry findings into another attempt without losing the issue history.
---

A revision is another attempt on the same issue. It keeps the plan, branch,
original base, and earlier evidence. The new request must explain which
findings or review comments to address.

Create `.foundry/marbles/_factory/revise.ts`:

<details>
<summary>Complete revise.ts</summary>

<include>./_example/_factory/revise.ts</include>

</details>

Replace `factory.ts` with this final implementation-and-review workflow:

<include>./_example/factory.ts</include>

```sh
marbles roll factory-revise --input '{"issue":42,"note":"Address the failed setup check and the reviewer finding about the test command."}'
```

The new implementation starts from the previous candidate and uses the same
branch. Its explanation and test results get another entry in the work log.
The original implementation remains visible.

## Stop when progress stalls

The sample allows three implementation attempts, including the first.
At that limit, hand the issue to a person with the latest commit, failed
checks, unresolved findings, and proposed next action. Retrying an
infrastructure failure is a separate decision from asking for another code
revision.

Blocked work needs inspection. A crash may have committed a change before
recording it. Resolve that mismatch before restarting a stage. A changed
requirement or branch base also needs a new plan and fresh verification;
do not carry an old approval onto the new commit.

Next: [Approve and deliver](/marbles/use-cases/software-factory/approve).
