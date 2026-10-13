---
title: Test and review
description: Run tests and collect review findings against the exact candidate commit.
---

Continue from [Implement a task](/marbles/use-cases/software-factory/implement).
This chapter opens a detached checkout of the candidate's `revision`,
installs its dependencies, runs its tests, and asks a reviewer to inspect it.
Tests and review operate on the same commit.

## Add the verifier

Create `.foundry/marbles/_factory/verify.ts`:

```ts
import { agent, step } from "@foundry/marbles";
import { z } from "zod";
import { changeSchema } from "./implement";

export const verifiedSchema = changeSchema.extend({
  tests: z.literal("passed"),
  findings: z.string(),
});

const reviewer = agent({
  name: "factory-reviewer",
  prompt: "Review the supplied commit range. Report correctness risks and missing tests. Do not edit, commit, push, or merge.",
});

export const verify = step("factory-verify")
  .input(z.object({ change: changeSchema }))
  .output(verifiedSchema)
  .do(({ input: { change }, workspaces, agents, exec }) =>
    workspaces.current.git.withWorktree({ base: change.revision }, async () => {
      await exec(["bun", "install", "--frozen-lockfile"]);
      await exec(["bun", "test"]);
      const session = await agents.session(reviewer);
      const reply = await session.generate(`Review ${change.base}..${change.revision}.`);
      const head = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim();
      const dirty = (await exec(["git", "status", "--porcelain"])).stdout.trim();
      if (head !== change.revision || dirty) {
        throw new Error("Verification changed the checkout; discard this evidence and rerun.");
      }
      return { ...change, tests: "passed" as const, findings: reply.text };
    })
  );
```

`exec` fails the step on a nonzero exit. A failed install or test therefore
stops the workflow before review or approval. Change these commands for
your project's real verification; a successful command is only evidence
for the checks it actually runs.

The final check rejects evidence if the checkout was modified or moved to
another commit. Prompts guide an agent; they do not enforce read-only access.

## Connect implementation to verification

Replace `.foundry/marbles/factory.ts` with:

```ts
import { workflow } from "@foundry/marbles";
import { z } from "zod";
import { implement } from "./_factory/implement";
import { verify } from "./_factory/verify";

export const factory = workflow("factory")
  .input(z.object({ task: z.string() }))
  .do(({ input }) => verify({ change: implement({}, input) }));
```

The child result becomes `verify`'s `input.change`. Neither stage has to
guess which branch or commit the other used.

## Verify the result

Run `factory` with a new small task, or check the previous candidate by
running `factory-verify` directly with the three values from its result:

```sh
marbles roll factory-verify --input '{"change":{"branch":"marbles/your-run","base":"BASE_SHA","revision":"CANDIDATE_SHA"}}'
```

Replace the placeholders before running. A successful result includes the
candidate SHA, `tests: "passed"`, and findings. A failing test appears as a
failed run with command output; it never produces that success result.

Review findings remain evidence for a person to assess. Continue with
[Add human approval](/marbles/use-cases/software-factory/approve).
