---
title: Persistent Reviewer
description: Compare new revisions with earlier findings in one retained conversation.
---

A reviewer becomes more useful when it can revisit unresolved findings. The
[agents and sessions guide](/quirks/guides/agents-and-sessions) provides a complete
configuration and two commands that reuse the same conversation.

Add a cadence to that configuration:

```ts
import { schedule } from "@foundry/quirks";

schedule("review-weekdays", {
  workflow: "review-project",
  input: "Review this revision against earlier findings. Report what remains unresolved.",
  at: { weekday: ["mon", "tue", "wed", "thu", "fri"], hour: 9 },
});
```

```sh
quirks once review-weekdays
quirks sessions
```

The schedule determines when to return. The stable session ID determines which
conversation to reuse. The workspace determines where that conversation lives
on disk. Compaction may replace older exchanges with summaries.

For a prebuilt reviewer in the current workspace, explicitly register it:

```ts
import { reviewSession } from "@foundry/quirks/prebuilt";
reviewSession();
```

```sh
quirks once review-session --input '{"sessionId":"project-review"}'
```

Use distinct session IDs for unrelated reviews. Retained context helps compare
findings but does not prove that the model remembers every detail correctly.
