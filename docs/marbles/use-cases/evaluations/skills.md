---
title: Test and improve skills
description: Compare skill instructions against concrete cases and review proposed improvements before adopting them.
---

Handwritten and agent-written skills need the same evidence. Test whether a
skill helps on its intended tasks, stays out of unrelated work, and avoids
known failures. Also test combinations you actually deploy; two useful skills
can give conflicting instructions.

## Run a small review check

This example checks whether a reviewer finds an ignored write error and
leaves the clean case alone. It compares a declared skill with no declared
skill. It is a wiring example with two fixtures, not proof of review quality.

Install [Marbles and a CLI provider](/marbles/get-started/installation) plus
`zod@4.4.3`. Create `skills/review/SKILL.md` in the automation project:

```md
---
name: review-write-errors
description: Review code that writes files and reports completion.
---

Trace write failures to the caller. Report an ignored-write-error when code
swallows the failure and still reports success. Do not flag a write whose
rejection reaches the caller. Cite the line that supports each finding.
```

Create `.foundry/marbles/_eval/evaluate.ts`:

<details>
<summary>Complete evaluate.ts</summary>

<include>./_example/evaluate.ts</include>

</details>

Then create `.foundry/marbles/skill-evals.ts`:

```ts
import "./_eval/evaluate";
```

Run each variant with the same provider and model. Omitting `model` uses
that provider's default:

```sh
marbles roll skill-eval --input '{"variant":"baseline","provider":"codex"}'
marbles roll skill-eval --input '{"variant":"candidate","provider":"codex"}'
```

Each completed run writes a `Skill evaluation trials` artifact version with the exact
skill text, cases, replies, grades, session references, and reported usage.
Compare the returned version IDs; the latest version alone is not the pair.
A completed run can contain failed cases. Read `passed` and the case results.
A timeout or cancellation can stop the step before that write. Include those
failed runs when comparing results.

The grader checks rule IDs and requires evidence text. A person must still
check whether that evidence is valid. The example does not test repository
navigation or tool use. CLI configuration and repository instructions remain
part of the environment, including in the baseline. Use isolated fixtures
and controlled permissions for a stronger comparison. The no-tools instruction
is a prompt; enforce restrictions through [session controls](/marbles/reference/agent-sessions)
when the evaluation requires them.

## Capture the skill you actually tested

The step reads `SKILL.md` when the run starts and constructs a `defineSkill`
from those bytes. The [skill resolver](https://github.com/Francois-Esquire/foundry/blob/main/apps/marbles/src/lib/managers/skills.ts)
caches content-backed skills by their contents. This avoids reusing a stale
directory-based skill after a file edit.

The example tests a single-file skill. For a skill with scripts or references,
capture those files too and pass them as `defineSkill({ manifest, files })`.
Hash and retain the whole set. Alternatively, start a fresh process that loads
the pinned directory. Recreating `skills.none().add(path)` in a running host
does not refresh its cached directory recipe.

## Improve a skill from failures

Give an improvement agent a failed case, its transcript, the expected result,
and the current skill. Ask it to propose a small change and explain why the
change should fix the failure. Keep the patch on a branch or in a candidate
directory, separate from the active skill.

Run the candidate against the full regression suite and held-out cases. Test
the skill alone, without it, and with the other skills normally selected.
Include cases where it should not apply. Inspect false positives and tool
use as well as successful outputs.

A person reviews the evidence and adopts a specific version. Preserve the
baseline and the reason for promotion or rejection. This is the self-improvement
loop: agents propose and test changes, while the owner controls what becomes
active. Bound attempts and model calls so an unsuccessful change ends in a
handoff instead of endless rewrites.

The [inspector](/marbles/use-cases/software-factory/improvement/inspector) can supply these
failure cases. Next, [monitor the skill file](/marbles/use-cases/evaluations/watch)
to rerun the check after edits.
