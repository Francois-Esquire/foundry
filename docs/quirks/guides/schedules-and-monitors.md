---
title: React to change and recur
description: Observe files and network sources, then choose when work returns.
---

A schedule decides when work runs. A monitor checks a source and decides whether
its handler should run. Begin with deterministic detection:

```ts
import { monitor } from "@foundry/quirks";

monitor("instruction-drift", async ({ log }, change) => {
  if (change.kind === "files") {
    log(JSON.stringify(change));
  }
}, { glob: "**/{AGENTS,CLAUDE}.md", every: "30s" });
```

```sh
quirks once instruction-drift
quirks run
```

The first observation reports existing matching files as added. Later
observations compare checksums with the last successfully handled snapshot.
Add an agent session when investigating the meaning of a change needs judgment;
the [caretaker pattern](/quirks/use-cases/repository-caretaker) does this.

## Network sources

These complete handlers log changes. Replace the illustrative URLs with your
sources before running them:

```ts
monitor("release-feed", async ({ log }, change) => {
  if (change.kind === "http") log(JSON.stringify(change.current));
}, { url: "https://example.com/releases.json", every: "1h" });

monitor("live-events", async ({ log }, change) => {
  if (change.kind === "ws") log(JSON.stringify(change.message));
}, { url: "wss://example.com/events" });
```

HTTP compares parsed values. `select` can narrow the value being compared.
WebSocket monitors deliver each message under `quirks run`; they do not
deduplicate, persist, or replay messages. Both still perform network I/O under
`--dry`.

## Choose a cadence

For the `inspect` handle in [Start Here](/quirks/start-here), either schedule is valid:

```ts
schedule("inspect-often", { workflow: inspect, input: null, at: "30m" });
schedule("inspect-monday", {
  workflow: inspect, input: null, at: { weekday: "mon", hour: 9, minute: 30 },
});
```

Import `schedule` alongside `step`. Calendar times are machine-local.
Foreground intervals count from completion and do not queue missed ticks.
Schedule locks skip overlapping executions held by a live process. Direct
`once <workflow>` does not take a schedule lock.

File monitors use native notifications during foreground execution, with polling
as a fallback. Events arriving while a monitor is busy are dropped. Polling can
detect remaining file differences later; WebSocket messages have no such recovery.

For macOS scheduling between processes, continue to [launchd](/quirks/guides/launchd).
