import { agent, Output, step } from "@foundry.sh/marbles";
import { z } from "zod";
import {
  baseBranch,
  chronicle,
  issueInput,
  issueSchema,
  newRecord,
  readRecord,
  recordEvent,
  repository,
  requireRecord,
} from "./record";

export const coverageSchema = z.object({
  backup: z.string().min(1),
  primary: z.string().min(1),
  runbook: z.string().url(),
});
const assessment = z.object({
  evidence: z.array(z.string()),
  nextAction: z.string(),
  severity: z.enum(["critical", "high", "normal"]),
});
const investigator = agent({
  prompt:
    "Investigate this incident using the issue, local code, and work log. Report evidence, severity, and the next action. Do not change files, deploy, or claim a service recovered without evidence.",
});
export const onCall = step("factory-on-call")
  .input(issueInput.extend({ coverage: coverageSchema }))
  .do(async ({ input, exec, workspaces, agents, report, run }) => {
    const response = await exec([
      "gh",
      "issue",
      "view",
      String(input.issue),
      "--repo",
      repository,
      "--json",
      "number,title,body,url,updatedAt,state",
    ]);
    const issue = issueSchema.parse(JSON.parse(response.stdout));
    await exec(["git", "fetch", "origin"]);
    const base = (
      await exec(["git", "rev-parse", `origin/${baseBranch}`])
    ).stdout.trim();
    const work = (await readRecord(input.issue)) ?? newRecord(issue, base);
    if (issue.state === "CLOSED") {
      if (work.status === "closed") {
        return work;
      }
      return recordEvent(
        { ...work, status: work.change ? work.status : "closed" },
        run.id,
        "incident closed",
        issue.url
      );
    }
    const marker = JSON.stringify({
      coverage: input.coverage,
      updatedAt: issue.updatedAt,
    });
    if (
      work.events.some(
        (event) => event.stage === "on-call observed" && event.detail === marker
      )
    ) {
      return work;
    }
    const result = await workspaces.current.git.withWorktree(
      { base },
      async () => {
        const session = await agents.session(investigator);
        return session.generate(
          `${issue.body}\n\n${chronicle(work)}\n\nRunbook: ${input.coverage.runbook}`,
          {
            output: Output.object({ schema: assessment }),
          }
        );
      }
    );
    const finding = assessment.parse(result.output);
    const next = await recordEvent(
      work,
      run.id,
      "on-call assessment",
      JSON.stringify(
        {
          ...input.coverage,
          ...finding,
          acknowledgeBy: new Date(Date.now() + 15 * 60_000).toISOString(),
          revision: base,
        },
        null,
        2
      )
    );
    report.result({
      body: `${input.coverage.primary} owns this incident. Backup: ${input.coverage.backup}.\n\n${finding.nextAction}`,
      title: `${finding.severity}: issue #${input.issue}`,
    });
    return recordEvent(next, run.id, "on-call observed", marker);
  });

step("factory-handoff")
  .input(
    issueInput.extend({ note: z.string().min(1), owner: z.string().min(1) })
  )
  .do(async ({ input, run }) =>
    recordEvent(
      await requireRecord(input.issue),
      run.id,
      "on-call handoff",
      `${input.owner}: ${input.note}`
    )
  );
