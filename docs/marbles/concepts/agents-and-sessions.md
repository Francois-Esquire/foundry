---
title: Agents and sessions
description: Declare who does model work, open a session in a step, and continue the conversation in a later run.
---

Install and authenticate Claude Code or Codex before running model turns.
Marbles detects `claude` and `codex` on `PATH` and prefers Claude Code when
both are present; `--harness` narrows the choice. Authentication belongs to
those CLIs.

```ts
import { agent, step } from "@foundry/marbles";
import { z } from "zod";

const reviewer = agent({
  prompt: "Review this repository without editing. Compare with earlier findings.",
});

const sessionRef = z.object({
  id: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
});

step("review-project")
  .input(z.object({ request: z.string(), session: sessionRef.optional() }))
  .do(async ({ input, agents }) => {
    const session = await agents.session(reviewer, input.session ? { session: input.session } : {});
    const reply = await session.generate(input.request);
    return { text: reply.text, session: session.ref };
  });
```

```sh
marbles roll review-project --input '{"request":"Review the repository and remember unresolved findings."}'
marbles roll review-project --input '{"request":"Compare this revision with your earlier findings.","session":{"id":"<id from the first result>","provider":"claude-code"}}'
marbles sessions
```

The first run opens a fresh session and returns its reference beside the
reply. The second passes that reference back and continues the same
conversation from disk. `sessions` lists it with its message count. The model
may still miss changes or misinterpret history.

## How sessions behave

- **Fresh by default.** Every `agents.session(def)` starts a new session.
  Continue one by reference, `{ session }`, never by an id you invented.
  Within a step the object works; across steps and runs the small
  `session.ref` handle does, as above. A ref belongs to the provider that
  opened it; continuing it with an agent on another provider starts a new
  session and logs a warning.
- **Replay returns the same session.** After a question, a pause, or a
  restart, a step body runs again from the top. The n-th `agents.session`
  call in the body returns the session it opened the first time, with its
  transcript, so keep those calls in a fixed order.
- **Wired by default.** The session runs in the step's working directory,
  which is the workspace root or, inside a worktree callback, the
  worktree. That is how `implement` in [Composition](/marbles/concepts/composition)
  works on its own branch without naming a directory. Its turns write to
  the step's stream and stop when the step is cancelled or paused. Pass
  `{ cwd }` only to leave that default.
- **Compaction is off.** `{ compaction: true }` lets older history be
  replaced by a summary made with the turn model; partial settings adjust
  it.

## Agents

`agent` declares who does the work: a prompt, optionally a `provider`
(`codex` or `claude-code`) and a `model` the provider serves. Declaring one
starts nothing; opening a session does. The prompt is an instruction, not a
permission; see [safety and limits](/marbles/safety-and-limits).

From the dashboard, `s` on a running step hands the agent a prompt mid-turn
and `p` parks the step; neither needs authored code.

## Prebuilt reviewers

`@foundry/marbles/prebuilt` has read-only steps with the sessions already
wired. `reviewInWorktree()` reviews any revision in a temporary checkout:

```ts
import { reviewInWorktree } from "@foundry/marbles/prebuilt";

reviewInWorktree();
```

```sh
marbles roll review-in-worktree --input '{"repository":".","base":"main"}'
```

To keep a review conversation across scheduled runs, see the
[persistent reviewer](/marbles/recipes/persistent-reviewer). The
[configuration reference](/marbles/reference/configuration#prebuilt-steps)
lists every prebuilt step, and the [API reference](/marbles/reference/api#context)
lists every session option.
