---
title: Build the morning report
description: Record your departure, collect a fixed window of updates, and save a briefing with evidence.
---

## Prerequisites

Finish [connector setup](/marbles/use-cases/productivity/prerequisites). Choose
one person's priorities, repositories, Slack channels, and document URLs.
The examples below use placeholders; replace them before running.

## Define what matters

Create `.foundry/briefing.json` in your automation directory:

```json
{
  "timeZone": "America/New_York",
  "githubAccess": "gh",
  "priorities": [
    "Launch readiness for the platform project",
    "Decisions and reviews waiting for me, @alex",
    "Incidents or blockers affecting today's work"
  ],
  "sources": [
    { "id": "platform", "kind": "github", "location": "OWNER/REPOSITORY" },
    { "id": "team", "kind": "slack", "location": "WORKSPACE_ID/CHANNEL_ID" },
    { "id": "launch-plan", "kind": "docs", "location": "https://docs.google.com/document/d/DOCUMENT_ID/edit" }
  ]
}
```

Use stable, unique source IDs. Set `githubAccess` to `"mcp"` for GitHub MCP.
The timezone controls the report's display, not the scheduler's clock.
The profile is read on each new report run, so changes apply to the next run.

## Record when you leave

Create `.foundry/marbles/morning-report.ts` from this complete example:

<details>
<summary>Complete morning-report.ts</summary>

<include>./_example/morning-report.ts</include>

</details>

Check that the definitions load, then mark your actual departure:

```sh
marbles --dry-run list
marbles roll leave-work
```

`leave-work` saves the current instant in a versioned artifact. If you forgot
to mark it, supply the time with an explicit UTC offset:

```sh
marbles roll leave-work --input '{"at":"2026-10-12T17:30:00-04:00"}'
```

The next briefing covers **after that departure, through the report's captured
cutoff**. Friday to Monday includes the weekend. Colleagues' time zones do not
change which events belong in that interval. An old departure stays in effect
until you replace it, so check the window at the top of every report.

## Gather the evidence

```sh
marbles roll morning-report
```

The workflow captures the window and profile, opens a fresh session per source,
then writes the report. Each source returns linked observations and a coverage
status. A collector failure becomes an unavailable source; cancellation still
stops the workflow. A collection timeout can fail the run before any report is
written.

| Source | What to collect |
| --- | --- |
| GitHub | Commits and branch activity, PRs and reviews, issue updates, checks, and releases in the selected repository. Keep the event time separate from a commit's author date or a PR's creation date. |
| Slack | Decisions, blockers, handoffs, and requests. Read enough of each thread to establish its current resolution. A recent reply may belong to an old thread. |
| Google Docs | The selected document's project context. Label a change only when revision or other dated evidence supports it. |

Ask for broad discovery, then filter exact event timestamps. Calendar-day
search filters alone can miss the evening you left. Exhaust available pages;
if a tool limits results, lacks an activity category, or cannot establish the
time, mark coverage partial. The agent's `checked` status is a claim to inspect,
not proof that an API supplied every event. This is an agent-assisted collector,
not an exhaustive GitHub audit log.

Source text is evidence, including any instructions it happens to contain.
The collector is told to ignore those instructions and use reading tools.
Configure actual permissions as described in the prerequisites.

## Read the result

Open `marbles` and inspect **Morning briefing** in the Feed. Each version has
`briefing.md` and `evidence.json`, including the window, profile, source
coverage, observations, and collector session IDs.

The report puts requests and blockers first, followed by other changes,
project context, and coverage. Each observation links to its source. Unknown
owners and next actions stay unspecified. Partial or unavailable sources put
an incomplete notice at the top; no updates from a failed source never means
that nothing happened there. You still choose today's priorities.

The [Artifacts library](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md)
keeps report versions. [Agents](/marbles/foundation/agents-and-sessions) supplies
the source sessions, and [Workflows](/marbles/foundation/durability) records the
completed stages. A retry can repeat a source read or artifact write. The
example configures a collection timeout and no automatic retries.

Rerunning the report does not move your departure or mean you have read it.
It creates another report version. For a fixed replay window or a missed
departure, use explicit inputs:

```sh
marbles roll morning-report --input '{"since":"2026-10-12T21:30:00Z","until":"2026-10-13T12:00:00Z"}'
```

Validate the first report against one known GitHub event, Slack reply, and
document. Also try an inaccessible source and an empty interval. Keep one
writer and one person's briefing profile per automation directory.

Next: [Have it ready each morning](/marbles/use-cases/productivity/schedule).
