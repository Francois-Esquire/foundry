---
title: Test and review
description: Check a candidate against the original issue, plan, implementation, and previous findings.
---

Review starts with context. The reviewer reads the original issue,
acceptance criteria, plan, implementation explanation, previous attempts,
and test output. It then examines the exact candidate commit. A candidate
is the committed revision proposed for this issue, identified by its SHA.

## Check engineering decisions

The review prompt and selected skills should name the project's expectations.
"Review this code" leaves too much unstated. Ask for evidence against the
accepted scope, including the reasons behind the first implementation.

To use an approved project skill, import `skills` from `@foundry/marbles`
and add `skills: skills.none().add("./skills/review")` to the reviewer
declaration. That directory must contain `SKILL.md`. Select skills for the
review's remit and retain their version with the evidence; use
[skill evaluations](/marbles/use-cases/evaluations/skills) before changing them.

| Decision | What to check |
| --- | --- |
| Add a dependency | Is it needed? Does the repository already supply it? Check its version, lockfile, license, maintenance status, and transitive dependencies. |
| Create a package | Is there a real owner and reusable responsibility? Check its exports, dependency direction, build, and tests. A folder alone may be enough. |
| Change a module | Does its interface keep complexity out of callers? Include ordering rules, errors, and compatibility in the review. |
| Change domain rules | Do names match the domain? Are invariants enforced where the state changes? |
| Add tests | Do they exercise the required result through the module's interface, including failure cases? Do they fail for the defect being fixed? |

Check the plan's promised commands against the actual evidence. The example
below runs installation and `bun test`; add the project's lint, typecheck,
build, or other required checks before relying on it for delivery. Missing
browser or service evidence stays missing even when a model says the code
looks correct.

## Run the verifier

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

For several reviewers, use the [PR review process](/marbles/use-cases/software-factory/pull-requests)
to assign different risks and synthesize their findings. This sample has one
reviewer. Adding more sessions without a synthesis step only adds more output.

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
