---
title: Persistent Reviewer
description: Compare new revisions with earlier findings in one retained conversation, on a cadence.
---

A reviewer becomes more useful when it can revisit unresolved findings. The
[agents and sessions](/marbles/foundation/agents-and-sessions) page continues a
conversation by passing the session reference from one `roll` to the next by
hand. A scheduled run has nobody to pass it, so the step keeps the reference
itself, in an artifact each run reads back with `latest()`:

## Before you start

You need the [installed CLI](/marbles/get-started/installation), an authenticated Claude Code or Codex CLI and `zod@4.4.3` installed in this project.
Save the module below as `.foundry/marbles/persistent-reviewer.ts` in your project.

## Write the automation

```ts
import { agent, artifact, schedule, step } from "@foundry/marbles";
import { z } from "zod";

// The session reference each run leaves for the next. A declared artifact
// belongs to this workspace, so `latest()` is what the last run here wrote.
const sessionRef = z.object({ id: z.string(), model: z.string().optional(), provider: z.string().optional() });
const memory = artifact({ name: "project-review session", type: "application/json" });

const reviewer = agent({
  prompt: "Review this repository without editing. Compare with earlier findings.",
});

const reviewProject = step("review-project")
  .input(z.object({ request: z.string() }))
  .do(async ({ input: { request }, agents }) => {
    const kept = await (await memory.latest())?.text("session.json");
    const session = await agents.session(reviewer, kept ? { session: sessionRef.parse(JSON.parse(kept)) } : {});
    const reply = await session.generate(request);
    await memory.write({ "session.json": JSON.stringify(session.ref) });
    return reply.text;
  });

schedule(
  reviewProject({}, { request: "Review this revision against earlier findings. Report what remains unresolved." })
).at({ weekday: ["mon", "tue", "wed", "thu", "fri"], hour: 9 });
```

## Run and verify

Copy the key printed by `list` into the placeholder before running:

```sh
marbles list
marbles roll <schedule-key>
marbles sessions
```

The schedule determines when to return; its key is `review-project` plus a
short hash of the request. The kept reference determines which conversation
to continue; the first run finds no version, starts one, and writes it. The
workspace determines where that conversation lives on disk. Under
`--dry-run`, `latest()` reads what real runs kept and the write stays in
memory, so a dry run never moves the reference.

Reading the reference before `agents.session` keeps the body replay-safe:
a replay reads a reference to the same session, and the session call
returns it. The write is recorded, so a replay does not add a second
version. Compaction, if enabled on the session, may replace older exchanges
with summaries.

For a prebuilt reviewer that keeps one conversation under a name of your
choosing, register it:

```ts
import { reviewSession } from "@foundry/marbles/prebuilt";
reviewSession();
```

```sh
marbles roll review-session --input '{"sessionId":"project-review"}'
```

Use distinct names for unrelated reviews. Retained context helps compare
findings but does not prove that the model remembers every detail correctly.

Run the same schedule key twice and inspect `marbles sessions`. The reviewer
should continue the retained session rather than create an unrelated
conversation. Keep the dashboard or headless loop running for automatic
weekday execution.
