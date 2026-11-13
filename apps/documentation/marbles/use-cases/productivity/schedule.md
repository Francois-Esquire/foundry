---
title: Have it ready each morning
description: Schedule the briefing locally, recover missed mornings, and choose how to read it.
---

## Prerequisites

Finish a [manual morning report](/marbles/use-cases/productivity/morning-report)
and inspect its source links and coverage. Confirm the computer's timezone,
the intended delivery time, and that the CLI can read the connectors without
an interactive login or permission prompt.

## Start the clock

Create `.foundry/marbles/morning-schedule.ts` beside `morning-report.ts`:

```ts
import { schedule } from "@foundry.sh/marbles";
import { morningReport } from "./morning-report";

for (const weekday of ["mon", "tue", "wed", "thu", "fri"] as const) {
  schedule(morningReport).at({ weekday, hour: 8, minute: 30 });
}
```

Calendar slots use the host machine's local timezone. Setting
`timeZone` in the briefing profile only changes displayed timestamps.
Choose the host timezone deliberately, especially if you travel or move
the workflow to another machine.

Run `marbles`; attaching the workspace starts the schedule. For a terminal
process without dashboard input:

```sh
marbles run </dev/null
```

Keep the host awake; the Marbles process keeps the schedule after the
command exits, until `marbles stop`. If the computer slept through
the slot, run `marbles roll morning-report` when you return. The saved
departure preserves the reporting window, so this still covers your absence.
If collection failed, inspect the failure and rerun with the same explicit
window when comparing attempts.

Record departure with `marbles roll leave-work` when you actually leave.
A fixed evening schedule can overwrite the right cutoff during a late workday
or holiday. For several people, use separate profiles and artifact identities;
this example uses one workspace per person.

## Read locally, then choose delivery

The sample saves the report files as an artifact and posts the readable
briefing to the local Feed. Keeping both local lets you include selected
private conversations without publishing them to the whole team.

To deliver it to Google Docs later, add a separate publishing step that takes
the exact report version and a pre-created destination document ID. Grant
write access to that destination, review its audience, and keep a delivery
record keyed by report version and destination. Replace a known section or
check that record before appending so a retry does not duplicate the report.
Optional Slack delivery needs the same destination and duplicate handling.
Neither publishing path is implemented by this sample.

## Keep the briefing useful

Adjust the priorities when work changes. Inspect missed events and false
urgency before changing the collector's instructions. Compare the candidate
against saved evidence using the [evaluation loop](/marbles/use-cases/evaluations).
A personal briefing can link to [Software Factory reports](/marbles/use-cases/software-factory/maintenance/automate)
without starting development or on-call work itself.

[Schedules](/marbles/foundation/triggers#schedules) explains local overlap
handling. Manual launches and a second machine need their own coordination.
[Remote execution](/marbles/reference/remote) covers running the same setup on
an always-on host; move credentials and state deliberately before switching
off the local copy.
