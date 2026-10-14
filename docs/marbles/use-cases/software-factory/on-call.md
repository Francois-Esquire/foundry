---
title: Run an on-call shift
description: Investigate incidents, name an owner, and leave evidence for the next shift.
---

An on-call shift watches for incidents and keeps a person responsible for
the response. In this local setup, incident issues are the intake source.
An agent investigates; the primary and backup own acknowledgement and action.

Create an `incident` label in GitHub. Put symptoms, timestamps, affected
services, and links to available evidence in each incident issue. This
chapter uses the same per-issue artifact as implementation and review.

## Assign coverage

Create `.foundry/on-call.json` in the project. Update it at each shift change:

```json
{
  "primary": "Maya",
  "backup": "Alex",
  "runbook": "https://YOUR-TEAM.example/runbooks/service"
}
```

Use your team's actual names and runbook URL. The scheduled patrol reads
this file on each run. Changing it does not transfer responsibility until
the next person acknowledges the handoff.

## Investigate and record

Create `.foundry/marbles/_factory/on-call.ts`:

<details>
<summary>Complete on-call.ts</summary>

<include>./_example/_factory/on-call.ts</include>

</details>

Create `.foundry/marbles/on-call.ts`:

<include>./_example/on-call.ts</include>

Launch `factory-on-call` with an issue and coverage, or let the scheduled
patrol supply them. The agent reads the current remote revision in a
temporary checkout. Its record includes the observed commit, severity,
evidence, next action, primary, backup, and acknowledgement deadline.
An unchanged issue and coverage reuse the recorded assessment.

## Acknowledge and hand off

Record who has taken responsibility and what they will do:

```sh
marbles roll factory-handoff --input '{"issue":42,"owner":"Maya","note":"Acknowledged. Investigating the timeout regression; next update at 14:30 UTC."}'
marbles roll factory-handoff --input '{"issue":42,"owner":"Alex","note":"Taking over. Reproduction and logs are attached to the issue; awaiting the database owner."}'
```

The patrol flags an assessment without a later acknowledgement after
15 minutes and names the backup in its report. That interval is a sample
policy. Use your incident policy, and contact the backup through your team's
normal channel. This example reports locally; it does not page anyone or
provision an on-call rotation service.

After mitigation, record the evidence and remaining work, close the incident
through your normal process, and run `factory-on-call` again to record its
closed state. If a code change is needed, add acceptance criteria and send
the issue through the implementation cycle. The investigation stays in its log.

Next: [Watch maintenance signals](/marbles/use-cases/software-factory/maintenance).
