---
title: Persistent Reviewer
description: Compare new revisions with earlier findings in one retained conversation, on a cadence.
---

A reviewer becomes more useful when it can revisit unresolved findings. The
[agents and sessions guide](/quirks/guides/agents-and-sessions) continues a
conversation by passing the session reference from one `once` to the next by
hand. A scheduled run has nobody to pass it, so the step keeps the reference
itself, in a small file in the workspace:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agent, schedule, step, type SessionRef } from "@foundry/quirks";
import { z } from "zod";

// A session reference kept in the workspace, so the next run can continue
// the conversation the previous run left.
function memory(root: string, name: string) {
  const file = join(root, ".quirks", `${name}.json`);
  return {
    load: (): Promise<SessionRef | undefined> =>
      readFile(file, "utf8").then((text) => JSON.parse(text) as SessionRef).catch(() => undefined),
    async save(ref: SessionRef) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(ref));
    },
  };
}

const reviewer = agent({
  prompt: "Review this repository without editing. Compare with earlier findings.",
});

const reviewProject = step("review-project")
  .input(z.object({ request: z.string() }))
  .do(async ({ input: { request }, agents, workspaces }) => {
    const kept = memory(workspaces.current.root, "project-review");
    const session = await agents.session(reviewer, { session: await kept.load() });
    const reply = await session.generate(request);
    await kept.save(session.ref);
    return reply.text;
  });

schedule(
  reviewProject({}, { request: "Review this revision against earlier findings. Report what remains unresolved." })
).at({ weekday: ["mon", "tue", "wed", "thu", "fri"], hour: 9 });
```

```sh
quirks list
quirks once <the schedule key list printed>
quirks sessions
```

The schedule determines when to return; its key is `review-project` plus a
short hash of the request. The kept reference determines which conversation
to continue; the first run starts one and saves it. The workspace determines
where that conversation lives on disk. The file write is the body's own work,
so it happens under `--dry` too.

Reading the file before `agents.session` keeps the body replay-safe: a
replay reads the same reference and the session call returns the same
session. Compaction, if enabled on the session, may replace older exchanges
with summaries.

For a prebuilt reviewer that keeps one conversation under a name of your
choosing, register it:

```ts
import { reviewSession } from "@foundry/quirks/prebuilt";
reviewSession();
```

```sh
quirks once review-session --input '{"sessionId":"project-review"}'
```

Use distinct names for unrelated reviews. Retained context helps compare
findings but does not prove that the model remembers every detail correctly.
