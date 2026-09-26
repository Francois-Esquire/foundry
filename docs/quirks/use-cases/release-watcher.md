---
title: Release Watcher
description: Observe release metadata and ask whether a change matters to this workspace.
---

This example observes Bun's latest release metadata. An HTTP monitor fires
whenever the body changes; the handler compares the release tag with the one
from the previous poll, so unrelated fields do not trigger another assessment.

```ts
import { agent, monitor } from "@foundry/quirks";

const assessor = agent({
  prompt: "Assess release relevance to this workspace. Report implications without changing dependencies.",
});

monitor("https://api.github.com/repos/oven-sh/bun/releases/latest")
  .every("6h")
  .do(async ({ change, agents, report, log }) => {
    if (change.kind !== "http") return;
    const tag = (value: unknown) =>
      typeof value === "object" && value !== null && "tag_name" in value ? String(value.tag_name) : undefined;
    const current = tag(change.current);
    if (current === undefined || current === tag(change.previous)) return;
    const session = await agents.session(assessor);
    const reply = await session.generate(`Assess Bun release ${current}. Inspect its release notes if available.`);
    log(reply.text);
    report.result({ title: `Bun ${current}`, body: reply.text });
  });
```

Run `quirks list` for the monitor's key, then `quirks once <key>` for one
observation or `quirks` to keep it polling. The first poll has no baseline, so
the first body counts as a change and the handler runs. A failed request logs
and keeps the previous observation; the observation is recorded only after
the handler resolves. Account for the service's rate limits. Dry execution
still sends the request; only the agent turn is echoed.

The report lands on the run and in the dashboard's Feed tab, so an
assessment is readable without opening logs.
