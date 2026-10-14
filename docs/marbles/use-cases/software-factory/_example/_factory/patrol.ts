import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { artifact, schedule, step } from "@foundry/marbles";
import { z } from "zod";
import { coverageSchema, onCall } from "./on-call";
import { baseBranch, readRecord, repository } from "./record";
import { status } from "./status";

const reports = artifact({ name: "Factory patrol", type: "text/markdown" });
const issuesSchema = z.array(
  z.object({
    labels: z.array(z.object({ name: z.string() })),
    number: z.number(),
    state: z.string(),
    title: z.string(),
    updatedAt: z.string(),
    url: z.string(),
  })
);
const patrol = step("factory-patrol").do(
  async ({ exec, workspaces, report, run }) => {
    await exec(["git", "fetch", "origin"]);
    const revision = (
      await exec(["git", "rev-parse", `origin/${baseBranch}`])
    ).stdout.trim();
    const previous = await (await reports.latest())?.text("revision.txt");
    const range = previous ? `${previous.trim()}..${revision}` : revision;
    const changes = await exec(["git", "log", "-10", "--oneline", range]);
    const response = await exec([
      "gh",
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--search",
      "label:factory-ready,incident",
      "--limit",
      "100",
      "--json",
      "number,title,url,state,updatedAt,labels",
    ]);
    const issues = issuesSchema.parse(JSON.parse(response.stdout));
    const coverage = coverageSchema.parse(
      JSON.parse(
        await readFile(
          join(workspaces.current.root, ".foundry/on-call.json"),
          "utf8"
        )
      )
    );
    const rows: string[] = [];
    let investigated = false;
    for (const issue of issues) {
      let work = await readRecord(issue.number);
      const marker = JSON.stringify({ coverage, updatedAt: issue.updatedAt });
      const observed = work?.events.some(
        (event) => event.stage === "on-call observed" && event.detail === marker
      );
      if (
        !investigated &&
        issue.state === "OPEN" &&
        !observed &&
        issue.labels.some((label) => label.name === "incident")
      ) {
        work = await onCall.run({ coverage, issue: issue.number });
        investigated = true;
      }
      if (work?.pullRequest) {
        work = await status.run({ issue: issue.number, quiet: true });
      }
      const assessment = work?.events.findLast(
        (event) => event.stage === "on-call assessment"
      );
      const handoff = work?.events.findLast(
        (event) => event.stage === "on-call handoff"
      );
      let attention = "";
      if (
        issue.state === "OPEN" &&
        assessment &&
        (!handoff || handoff.at < assessment.at)
      ) {
        const due = z
          .object({ acknowledgeBy: z.string(), backup: z.string() })
          .parse(JSON.parse(assessment.detail));
        if (Date.now() > Date.parse(due.acknowledgeBy)) {
          attention = `; acknowledgement overdue, ${due.backup} needs to take over`;
        }
      }
      rows.push(
        `- [#${issue.number}](${issue.url}) ${issue.title}: ${work?.status ?? issue.state}${attention}`
      );
    }
    const body = [
      `Run: ${run.id}`,
      `Fetched origin/${baseBranch}: ${revision}`,
      "## Latest commits",
      changes.stdout || "No new commits since the last report.",
      "## Issues and incidents",
      ...rows,
      "This report covers up to 100 labeled issues and 10 commits. Check the tracker and Git history for the rest.",
    ].join("\n\n");
    const version = await report.artifact(
      reports,
      {
        "patrol.md": `# Factory patrol\n\n${body}`,
        "revision.txt": revision,
      },
      { body }
    );
    return { issues: issues.length, report: version.id, revision };
  }
);

schedule(patrol).every("15m");
