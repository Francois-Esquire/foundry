---
title: Review an existing PR
description: Dispatch focused reviewers with shared context and synthesize findings before requesting changes.
---

A PR can enter the factory for review even when the factory did not implement
it. Create a review record keyed by repository, PR number, and head SHA.
Link its issue log if one exists. Missing context should produce a question
or a limited review, never an invented requirement.

## Capture the review packet

Before dispatching reviewers, fetch the PR and pin its base and head commits.
Include the original request, acceptance criteria, implementation explanation,
changed files, test output, known constraints, and earlier findings. Read the
relevant callers and repository instructions alongside the diff.

Do not carry an approval forward when the head changes. Recheck the base as
well; a changed integration target can invalidate otherwise useful evidence.

## Choose the depth

| Change | Review to request |
| --- | --- |
| Small, local change | One reviewer checks intent, correctness, and the relevant tests. |
| Shared interface or domain rules | Add a reviewer for callers, invariants, compatibility, and failure modes. |
| New dependency or package | Check necessity, existing alternatives in the repository, ownership, public exports, and build/runtime impact. |
| Sensitive data or access controls | Add the appropriate specialist and retain a human decision. |

Extra reviewers earn their place by checking different risks. Give each the
same revision and context, with a clear remit. Collect independent findings
before showing one review to another reviewer. Several agreeing models may
still share the same mistaken assumption.

## Synthesize before revising

The review lead checks each finding against the candidate. Require a file or
record reference, the triggering condition, the consequence, and a way to
verify it. Deduplicate overlapping reports. Classify findings as accepted,
rejected with a reason, or unresolved with a question.

Keep raw reviews and the synthesis. A vote count is not evidence. A style
preference should not become a correctness blocker unless it violates an
agreed project rule. When evidence conflicts, ask the owner instead of
forcing consensus.

Send the implementer only the accepted revision request, plus the original
intent and links to the full review. After the change, rerun the affected
checks and verify the new SHA. Record why a finding was declined so the
[inspector](/marbles/use-cases/software-factory/inspector) can evaluate review quality.

## Wire it into Marbles

This is the workflow shape to author, not a built-in PR service:

```text
capture PR and context
  → test pinned checkout
  → dispatch independent reviewers
  → synthesize findings
  → human decision
  → revision and fresh verification
```

Use [Workspaces](/marbles/foundation/workspaces-and-sandboxes) for pinned
checkouts, separate [agent sessions](/marbles/foundation/agents-and-sessions)
for independent reviews, and [parallel children](/marbles/foundation/composition)
when their inputs are ready. Persist the packet and results in an
[artifact](/marbles/foundation/artifacts-and-results). Keep posting comments
or submitting a GitHub review as a separate, explicitly authorized step.

The [issue verifier](/marbles/use-cases/software-factory/verify) is a runnable
starting point for the checkout, checks, and evidence handling. It expects
an issue work log; adapt its input before using it for an unrelated PR.

A schedule can poll open PRs and dispatch changed heads. Track the last
reviewed SHA and any pending review for each PR, cap work per poll, and retry
failed reviews deliberately. The existing patrol reports tracked PR status;
it does not automatically dispatch these reviewers.
