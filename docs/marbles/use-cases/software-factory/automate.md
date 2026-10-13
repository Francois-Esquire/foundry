---
title: Automate subsequent runs
description: Reuse the verifier to check an existing revision on a local schedule.
---

The attended `factory` workflow accepts a new task and asks for a decision.
For recurring work, add a check of the existing repository revision. It
reuses [the verifier](/marbles/use-cases/software-factory/verify) and writes
findings without waiting for an answer.

This example requires at least two commits because its default comparison
base is `HEAD~1`. It checks local commits; it does not fetch remote changes.

## Add the recurring check

Create `.foundry/marbles/factory-check.ts` alongside `factory.ts`:

```ts
import { artifact, schedule, step, workflow } from "@foundry/marbles";
import { z } from "zod";
import { changeSchema } from "./_factory/implement";
import { verifiedSchema, verify } from "./_factory/verify";

const reports = artifact({ name: "Factory checks", type: "text/markdown" });

const snapshot = step("factory-snapshot")
  .input(z.object({ base: z.string() }))
  .output(changeSchema)
  .do(async ({ input, exec }) => ({
    branch: "HEAD",
    base: (await exec(["git", "rev-parse", input.base])).stdout.trim(),
    revision: (await exec(["git", "rev-parse", "HEAD"])).stdout.trim(),
  }));

const publishCheck = step("factory-check-report")
  .input(z.object({ checked: verifiedSchema }))
  .do(async ({ input: { checked }, report }) => {
    const version = await report.artifact(reports, {
      "check.md": `Commit: ${checked.revision}\nTests: ${checked.tests}\n\n${checked.findings}`,
    });
    return { revision: checked.revision, report: version.id };
  });

const check = workflow("factory-check")
  .input(z.object({ base: z.string().default("HEAD~1") }))
  .do(({ input }) =>
    publishCheck({ checked: verify({ change: snapshot({}, input) }) })
  );

schedule(check).at({ weekday: "fri", hour: 16 });
```

## Run it now, then on a clock

```sh
marbles roll factory-check
marbles list
marbles
```

The first command returns a report version after passing verification.
Open the dashboard's Feed to read it. `list` shows the Friday schedule.
Press Enter in the dashboard to start triggers, and keep Marbles running
for the Friday 16:00 slot in the machine's local timezone.

For unattended operation use `marbles run </dev/null`. Failed verification
fails that run; it does not publish a success report. Use run history and
logs to diagnose it. Schedules do not install a service or keep running
after the Marbles process stops.

## Extend the trigger

A file or HTTP monitor can also launch a workflow by returning its locked
target. Start with [Schedules and monitors](/marbles/foundation/triggers)
before connecting an issue source. Validate incoming data and account for
duplicate delivery; a first poll treats the current source as a change.

For a remote machine, use the same single-host CLI model described in
[remote execution](/marbles/reference/remote). Marbles has no remote
deployment command or distributed worker coordinator.
