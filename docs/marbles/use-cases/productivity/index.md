---
title: Productivity
description: Build a morning briefing from the work your team did while you were away.
sidebar:
  label: The morning briefing
---

You finish work in New York while colleagues in Singapore and London are
still moving. By morning, a PR has merged, someone has asked for a decision,
and the launch plan has changed. Bring that work into one report before
opening every inbox.

This is a starting point for a personal productivity assistant in the spirit
of Motion. The first workflow prepares your morning briefing. You choose the
priorities and decide what to do next; calendar planning can come later.

```text
mark when you leave → gather updates → identify what needs you → save the briefing
```

## What arrives in the morning

| Section | What it tells you |
| --- | --- |
| Needs your attention | Blockers, direct requests, pending decisions, and their owners when known. |
| What changed | GitHub activity and important Slack updates during your absence, with source links. |
| Project context | Relevant Google Docs content and older discussions needed to understand the changes. |
| Coverage | Which sources were checked, where access failed, and what remains unverified. |

Group related work by project when reading the report. A merged PR and the
Slack thread announcing it describe the same work; follow their links for
different evidence. Urgency should come from a deadline, blocker, or request,
not the number of messages in a channel.

## Prerequisites

Start with [Marbles installed](/marbles/get-started/installation), an authenticated
CLI agent, Google Docs MCP, Slack MCP, and either GitHub MCP or `gh`. Use a
dedicated local automation directory for one person's report.

[Connect the sources](/marbles/use-cases/productivity/prerequisites) explains
each prerequisite and how to check access. Then
[build the report](/marbles/use-cases/productivity/morning-report) and
[schedule it](/marbles/use-cases/productivity/schedule).

The workflow saves a versioned artifact with the report and its evidence,
and posts the readable briefing to the Marbles Feed. Both stay local; source
reads require network access. The example does not post messages or edit
shared documents.
