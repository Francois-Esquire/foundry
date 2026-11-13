import { step } from "@foundry.sh/marbles";
import { z } from "zod";
import {
  chronicle,
  issueInput,
  recordEvent,
  repository,
  requireRecord,
} from "./record";

export const status = step("factory-status")
  .input(issueInput.extend({ quiet: z.boolean().default(false) }))
  .do(async ({ input, exec, report, run }) => {
    let work = await requireRecord(input.issue);
    if (work.pullRequest) {
      const response = await exec([
        "gh",
        "pr",
        "view",
        String(work.pullRequest.number),
        "--repo",
        repository,
        "--json",
        "state,headRefOid,mergeCommit,mergedAt",
      ]);
      const pr = z
        .object({
          headRefOid: z.string(),
          mergeCommit: z.object({ oid: z.string() }).nullable(),
          mergedAt: z.string().nullable(),
          state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        })
        .parse(JSON.parse(response.stdout));
      const issue = await exec([
        "gh",
        "issue",
        "view",
        String(input.issue),
        "--repo",
        repository,
        "--json",
        "state",
      ]);
      const issueState = z
        .object({ state: z.string() })
        .parse(JSON.parse(issue.stdout)).state;
      const matches = pr.headRefOid === work.pullRequest.revision;
      const currentCandidate = pr.headRefOid === work.change?.revision;
      let nextStatus = work.status;
      if (pr.state === "CLOSED" || !matches) {
        nextStatus = "blocked";
      }
      if (pr.state === "MERGED" && matches && currentCandidate) {
        nextStatus = issueState === "CLOSED" ? "closed" : "merged";
      }
      if (pr.state === "MERGED" && !currentCandidate) {
        nextStatus = "blocked";
      }
      if (nextStatus !== work.status) {
        work = await recordEvent(
          { ...work, status: nextStatus },
          run.id,
          "delivery observed",
          JSON.stringify(
            { currentCandidate, issueState, pr, publishedHeadMatches: matches },
            null,
            2
          )
        );
      }
    }
    if (!input.quiet) {
      report.result({
        body: chronicle(work),
        title: `Issue #${input.issue}: ${work.status}`,
      });
    }
    return work;
  });
