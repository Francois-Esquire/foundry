---
title: Add human approval
description: Ask for a decision on a verified commit and save the evidence as a report.
---

Continue from [Test and review](/marbles/use-cases/software-factory/verify).
This stage pauses for a decision in the dashboard and writes a report
containing the exact commit, test result, review findings, and decision.

## Add the decision and report steps

Create `.foundry/marbles/_factory/approve.ts`:

```ts
import { artifact, step } from "@foundry/marbles";
import { z } from "zod";
import { verifiedSchema } from "./verify";

const decisionSchema = verifiedSchema.extend({
  approved: z.boolean(),
  note: z.string(),
});
const decisions = artifact({ name: "Factory decisions", type: "text/markdown" });

export const approve = step("factory-approve")
  .input(z.object({ checked: verifiedSchema }))
  .output(decisionSchema)
  .do(async ({ input: { checked }, ask }) => {
    const decision = await ask.approval({
      title: "Accept this candidate?",
      body: `Commit: ${checked.revision}\nTests: ${checked.tests}\n\n${checked.findings}`,
    });
    return { ...checked, approved: decision.approved, note: decision.note ?? "" };
  });

export const publishDecision = step("factory-report")
  .input(z.object({ decision: decisionSchema }))
  .do(async ({ input: { decision }, report }) => {
    const markdown = [
      `# ${decision.approved ? "Accepted" : "Rejected"} candidate`,
      `Branch: ${decision.branch}`,
      `Base: ${decision.base}`,
      `Commit: ${decision.revision}`,
      `Tests: ${decision.tests}`,
      decision.findings,
      decision.note,
    ].join("\n\n");
    const version = await report.artifact(decisions, { "decision.md": markdown });
    return { approved: decision.approved, revision: decision.revision, report: version.id };
  });
```

The ask is the first operation in its step. When the person answers, Marbles
replays that body with the recorded answer. The finished implementation and
verification steps keep their results. The report is a separate step, so
its artifact write follows the decision.

## Complete the workflow

Replace `.foundry/marbles/factory.ts` with:

```ts
import { workflow } from "@foundry/marbles";
import { z } from "zod";
import { approve, publishDecision } from "./_factory/approve";
import { implement } from "./_factory/implement";
import { verify } from "./_factory/verify";

export const factory = workflow("factory")
  .input(z.object({ task: z.string() }))
  .do(({ input }) =>
    publishDecision({
      decision: approve({ checked: verify({ change: implement({}, input) }) }),
    })
  );
```

## Launch and answer

Run `marbles`, press Enter, select `factory` in the Marbles panel, and launch
it with a task. After successful tests and review, the run waits at
**Accept this candidate?**. Open the question in the Feed and answer it.

The completed run returns the decision, commit, and report version ID.
The Feed contains the report. Both acceptance and rejection are recorded;
neither merges or pushes the branch. If you later merge it, verify you are
merging the recorded SHA rather than an updated branch tip.

Use the dashboard for this version. `roll factory` has nobody to answer and
cancels at the question, after doing the preceding work. A parked dashboard
run can be adopted after restart when its source and state remain available.

Continue with [Automate subsequent runs](/marbles/use-cases/software-factory/automate).
