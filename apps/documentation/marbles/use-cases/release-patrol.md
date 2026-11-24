---
title: Release patrol
description: Turn upstream releases into upgrade tasks, with the assessment routed by quota.
---

Someone on the team reads the Bun changelog every few weeks, usually after
something broke. This patrol reads it for you. An HTTP monitor polls the
latest release. When the tag changes, an agent reads the notes against your
repository and, if anything needs doing, files a task.

It uses three marbles: an HTTP monitor, an agent that routes itself by
quota, and the task backlog. It needs an authenticated Claude Code or Codex
CLI, and the current source checkout for `agent(name, fn)` and
`monitor(...).name()`.

## The module

Save this as `.foundry/marbles/release-patrol.ts`:

<include>./_example/release-patrol.ts</include>

## How the pieces work

- **The agent picks its own route.** `agent("release-patrol", fn)` builds
  its definition each time a session opens. It reads how much of the
  Claude weekly window is left with `usage.share("anthropic")` and moves to
  Codex below 20%. A route set by `extend` or a dispatch wins. See
  [routing by usage](/marbles/concepts/usage).
- **The monitor ignores noise.** GitHub's release JSON changes for reasons
  other than a new release, so the handler compares `tag_name` with the
  previous body and returns early when it matches.
- **The work becomes a task.** A task outlives the run that found it. It
  shows up in `marbles tasks list --tag upgrade`, in the digest below, and
  in any observer that watches the backlog.

## Run it

```sh
marbles roll bun-release
marbles tasks list --tag upgrade
```

The first poll has no baseline, so it treats the current release as new and
runs the assessment once. Then `marbles attach` leaves the monitor polling.

## Make it yours

- **Post a weekday digest.** Add a step that lists what waits on a person
  and what failed, and schedule it for nine on weekdays. Import `runs`,
  `schedule`, and `step` as well. Calendar slots use the machine's local
  time.

```ts
const morning = step("patrol-morning").do(async ({ report }) => {
  const tagged = await tasks.list({ tags: { any: ["upgrade", "needs-owner"] } });
  const waiting = tagged.items.filter((task) => task.settledAt === null);
  const failed = (await runs.list({ status: "failed" })).slice(-5);
  const lines = [
    ...waiting.map((task) => `- Waiting: ${task.title} (${task.id})`),
    ...failed.map((run) => `- Failed: ${run.name} (${run.id})`),
  ];
  report.result({ body: lines.join("\n") || "Nothing needs you.", title: "Release patrol" });
  return { failed: failed.length, waiting: waiting.length };
});

schedule(morning).at({ hour: 9, weekday: ["mon", "tue", "wed", "thu", "fri"] });
```

- **Watch your own dependencies.** Copy the monitor for each upstream you
  care about, each with its own `.name()`.
- **Hand upgrades to the factory.** Tag the task `factory` instead of
  `upgrade`, and the [Software Factory](/marbles/use-cases/software-factory)
  builds, verifies, and asks you to approve the upgrade.
- **Page someone.** Add an `observe(workflow, ..., { types: ["run.failed"] })`
  handler that posts to your chat tool when a patrol run fails.
