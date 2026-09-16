---
title: Implement–Review Loop
description: Compose implementation and review with a bounded stopping condition.
---

Quirks includes `implement`, `review`, `develop-round`, and `develop` as executable
examples. `develop` gives implementation to the first selected harness and
review to the second, falling back to the first when only one is available.
Findings feed into another round, up to five rounds.

```sh
quirks once develop --dry \
  --input '{"task":"Add a --json flag to list","cwd":".","round":1,"findings":[]}'
```

Remove `--dry` to perform real model operations. The current review parser accepts
a standalone `PASS` line or an empty response as no findings. This is a model
verdict; the built-in does not independently prove verification passed.

## Compose your own loop

This smaller configuration makes the stopping condition visible:

```ts
import { agent, loopUntil, step, workflow } from "@foundry/quirks";

const implementer = agent("builder", { prompt: "Implement the requested change." });
const reviewer = agent("verifier", {
  prompt: "Review the change without editing. Reply exactly PASS if satisfied; otherwise report findings.",
});

const round = step("implementation-round", async ({ agents, executors, workspace }, task: string) => {
  const implementation = await agents.session(implementer, { cwd: workspace.root });
  await implementation.generate(task);
  const review = await agents.session(reviewer, {
    cwd: workspace.root, executor: executors[1] ?? executors[0],
  });
  const reply = await review.generate(`Review this task and its implementation: ${task}`);
  return reply.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
});

workflow<string, { review: string; settled: boolean }>("implement-and-review", (graph) => {
  graph.step("attempts", loopUntil({
    body: round,
    maxRounds: 3,
    until: ({ output }) => output.trim() === "PASS",
    next: ({ output }, task) => `${task}\nAddress this review:\n${output}`,
  }), ({ input }) => input)
    .output(({ attempts }) => ({ review: attempts.output, settled: attempts.settled }));
});
```

Run `quirks once implement-and-review --input '"Describe your task here"'` in a
checkout where you intend the harness to make changes. Add an ordinary step
that runs your actual verification command, and incorporate its result into the
stopping predicate when passing tests must govern completion.

For independent reviews in a temporary checkout, use
`quirks once review-in-worktree --input '{"repository":".","base":"main"}'`.
Worktree isolation is not a security sandbox.
