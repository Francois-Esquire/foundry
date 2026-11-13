---
title: Approve and deliver
description: Approve the exact reviewed commit, publish its pull request, and track completion.
---

Publication is a separate workflow. It loads the issue's record and asks a
person to approve the verified commit. Approval permits pushing that commit
and opening or updating its pull request.

## Record the decision

Create `.foundry/marbles/_factory/approve.ts`:

<details>
<summary>Complete approve.ts</summary>

<include>../_example/_factory/approve.ts</include>

</details>

The ask happens before the decision write. If the run parks, Marbles can
replay that step with the recorded answer. Earlier implementation and
verification results stay in the issue's artifact.

## Publish the candidate

Create `.foundry/marbles/_factory/publish.ts`:

<details>
<summary>Complete publish.ts</summary>

<include>../_example/_factory/publish.ts</include>

</details>

The step checks the local branch, pushes the approved SHA, and reuses an
existing open PR for that branch. It records the returned URL and checks
that the remote head matches. A partial failure can leave a push or PR
completed before the log write. Inspect it before continuing.
If the record still says `approved` and its commit is unchanged, rerun
`factory-deliver` to finish publication using the recorded decision.

The PR body links the issue and carries the work log. Review it before
publishing if the log contains information that should stay local.
[GitHub's PR command](https://cli.github.com/manual/gh_pr_create) documents
issue-closing references and explicit base and head branches.

## Observe merge and closure

Create `.foundry/marbles/_factory/status.ts`:

<details>
<summary>Complete status.ts</summary>

<include>../_example/_factory/status.ts</include>

</details>

Then create `.foundry/marbles/delivery.ts`:

<include>../_example/delivery.ts</include>

Open `marbles`, start the dashboard, and launch `factory-deliver` with
`{"issue":42}`. Read the evidence and answer the publication question.
Use the dashboard because `roll` cannot answer it.

Repository review, CI, branch protection, and merge still happen through
your normal GitHub process. Afterward, run:

```sh
marbles roll factory-status --input '{"issue":42}'
```

The status step reads [the PR's state and head](https://cli.github.com/manual/gh_pr_view)
and the issue's state. It marks the record closed only after observing a
merge of the reviewed head and a closed issue. A moved head requires fresh
verification. A rejected candidate or closed, unmerged PR is not delivery.

For ongoing maintenance, continue with
[Review existing pull requests](/marbles/use-cases/software-factory/maintenance/pull-requests)
or [Run an on-call shift](/marbles/use-cases/software-factory/maintenance/on-call).
