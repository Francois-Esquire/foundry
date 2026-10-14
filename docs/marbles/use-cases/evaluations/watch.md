---
title: Run checks when files change
description: Launch an evaluation from a skill edit and keep the feedback loop bounded.
---

After the [manual skill check](/marbles/use-cases/evaluations/skills) works,
replace `.foundry/marbles/skill-evals.ts` with this module. It watches the skill
file and launches the named evaluation step when its contents change.

```ts
import { monitor } from "@foundry.sh/marbles";
import { evaluateSkill } from "./_eval/evaluate";

monitor("skills/review/SKILL.md")
  .every("1m")
  .do(({ files, report }) => {
    if (files?.removed.length) {
      report.milestone({
        title: "Review skill removed; evaluation needs a skill.",
      });
      return;
    }
    return evaluateSkill({}, { variant: "candidate", provider: "codex" });
  });
```

The handler returns a childless lock of a named step. A bare definition would
not launch anything. Run `marbles list`, inspect the monitor with
`marbles roll <monitor-key>`, then keep `marbles` or `marbles run </dev/null`
running to poll continuously. The first observation includes an existing file,
so it can launch the first check without an edit.
Each launch makes two model calls. Choose the polling cadence with that
usage in mind.

## Keep the observation and result distinct

The monitor detects a change. The evaluation reads the skill when its run
starts and records the digest of that snapshot. An edit between detection
and execution may mean it tests a newer version. Use the report's digest
when comparing results, and enqueue immutable snapshots if every intermediate
edit must be tested.

Keep reports outside the watched path so writing a result cannot trigger
another evaluation. For a larger skill, watch its scripts and references too.
For suite or prompt edits, extend the watched paths and restart Marbles when
you change the TypeScript modules themselves.

## Add recurrence deliberately

A scheduled trial can catch provider changes even when files stay the same.
Add `schedule(evaluateSkill({}, { variant: "candidate", provider: "codex" })).every("1d")`
to the module and import `schedule` when that recurring cost is useful. Rerun
the baseline under the same conditions before attributing a score change to
the skill.

Cap cases, per-step timeout, and improvement attempts. A monitor's polling
interval does not limit all manually or independently launched trials. Use
one dispatch path or coordinate claims before adding several producers.
Pending launches can be redelivered; a failed trial is not automatically
relaunched just because its files are unchanged. See [trigger delivery](/marbles/foundation/triggers#launch-work-from-a-change).

This loop reports evidence. It does not rewrite the watched skill or adopt
an improvement automatically. Feed its failures into the
[reviewed improvement loop](/marbles/use-cases/evaluations/skills#improve-a-skill-from-failures).
