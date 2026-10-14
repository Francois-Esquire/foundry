---
title: Schedule updates and reports
description: Fetch remote changes, report tracked work, and keep on-call attention visible.
---

Once one issue has completed the cycle, add a patrol. Every 15 minutes it
fetches remote refs, lists labeled issues, investigates one new or changed
incident, checks tracked PRs, and publishes a report.

Keep delivery and maintenance as separately launchable workflows. This
patrol gathers status. A [PR review](/marbles/use-cases/software-factory/pull-requests)
or [inspection](/marbles/use-cases/software-factory/inspector) is additional
work with its own inputs and limits. Schedule those only after a manual run
produces evidence you can use.

Create `.foundry/marbles/_factory/patrol.ts`:

<details>
<summary>Complete patrol.ts</summary>

<include>./_example/_factory/patrol.ts</include>

</details>

Create `.foundry/marbles/patrol.ts`:

<include>./_example/patrol.ts</include>

The query includes issues labeled `factory-ready` or `incident`, including
closed issues so delivery can be observed. It is bounded to 100 issues and
10 recent commits. Increase coverage or paginate before using it for a larger
queue. Keep a tracked issue's label until its delivery has been recorded.

## Run once before scheduling

```sh
marbles roll factory-patrol
marbles list
marbles
```

Inspect the report in the Feed, then start triggers in the dashboard.
For unattended operation, use `marbles run </dev/null`. Keep the process
running; schedules stop when it exits.

## What the report tells you

The versioned `Factory patrol` artifact records the fetched revision,
recent commits, issue progress, unstarted work, open incidents, and overdue
acknowledgements. It keeps the last reported revision for the next comparison.
Use `factory-status` to read one issue's full chronicle.

Fetching brings in new remote changes without merging them into the active
checkout. New issues pin that fetched revision. Existing candidates retain
their recorded base until you deliberately update and reverify them.

The patrol's calls to `factory-on-call` and `factory-status` use `.run()`.
They belong to the patrol's execution rather than appearing as separate
dashboard runs. Their issue logs still record the results. Run those steps
by name when investigating one issue directly.

## Advance ready work

Use the report to select the next issue, then run
`marbles roll factory --input '{"issue":42}'`. Keep publication attended.
The patrol does not interpret every observed issue as permission to edit code.

This sample assumes one writer per issue. A schedule's local overlap lock
does not protect against a second manual launch or another machine.
Before adding automatic claims, define ownership, duplicate handling, and
recovery of partially completed work. [Remote execution](/marbles/reference/remote)
and the [roadmap](/marbles/roadmap) describe the current deployment limits
and future webhook support.
