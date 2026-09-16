---
title: Release Watcher
description: Observe release metadata and ask whether a change matters to this workspace.
---

This example observes Bun's latest release metadata. It compares the selected
release tag, so unrelated response fields do not trigger another review.

```ts
import { agent, monitor } from "@foundry/quirks";

const assessor = agent("release-assessor", {
  prompt: "Assess release relevance to this workspace. Report implications without changing dependencies.",
});

monitor("bun-releases", async ({ agents, workspace, log }, change) => {
  if (change.kind !== "http") return;
  const session = await agents.session(assessor, {
    cwd: workspace.root, sessionId: "bun-releases",
  });
  const reply = await session.generate(`Assess release ${JSON.stringify(change.current)}. Inspect release notes if available.`);
  for (const part of reply.parts) {
    if (part.type === "text") log(part.text);
  }
}, {
  url: "https://api.github.com/repos/oven-sh/bun/releases/latest",
  headers: { Accept: "application/vnd.github+json" },
  every: "6h",
  select(value) {
    if (typeof value !== "object" || value === null || !("tag_name" in value)) {
      throw new Error("Expected release metadata");
    }
    return value.tag_name;
  },
});
```

Use `quirks once bun-releases` for one observation or `quirks run` for recurrence.
The first successful observation invokes the handler. HTTP failures leave the
previous snapshot intact. Account for the service's rate limits and supply
authentication in your config when needed. Dry execution still sends the request.
