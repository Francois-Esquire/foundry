import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step } from "@foundry/marbles";
import { z } from "zod";
import {
  baseBranch,
  chronicle,
  recordEvent,
  recordSchema,
  repository,
  workInput,
} from "./record";

const prSchema = z.object({
  headRefOid: z.string(),
  number: z.number(),
  state: z.string(),
  url: z.string(),
});
export const publish = step("factory-publish")
  .input(workInput)
  .output(recordSchema)
  .do(async ({ input: { work }, exec, report, run }) => {
    if (work.status === "declined") {
      return work;
    }
    const { change } = work;
    if (
      work.status !== "approved" ||
      !change ||
      !work.decision?.approved ||
      work.decision.revision !== change.revision ||
      work.verification?.revision !== change.revision
    ) {
      throw new Error(
        "Publication requires approval and verification of this exact commit."
      );
    }
    const head = (
      await exec(["git", "rev-parse", `refs/heads/${change.branch}`])
    ).stdout.trim();
    if (head !== change.revision) {
      throw new Error("The branch moved after verification.");
    }
    const listed = await exec([
      "gh",
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      change.branch,
      "--base",
      baseBranch,
      "--state",
      "all",
      "--json",
      "number,url,state,headRefOid",
      "--limit",
      "2",
    ]);
    const prs = z.array(prSchema).parse(JSON.parse(listed.stdout));
    if (prs.length > 1 || prs.some((pr) => pr.state !== "OPEN")) {
      throw new Error("Reconcile the existing pull request before publishing.");
    }
    const folder = await mkdtemp(join(tmpdir(), "factory-pr-"));
    try {
      const body = join(folder, "body.md");
      await writeFile(
        body,
        `Closes #${work.issue.number}\n\n${chronicle(work)}`
      );
      await exec([
        "git",
        "push",
        "origin",
        `${change.revision}:refs/heads/${change.branch}`,
      ]);
      const [existing] = prs;
      if (existing) {
        await exec([
          "gh",
          "pr",
          "edit",
          String(existing.number),
          "--repo",
          repository,
          "--body-file",
          body,
        ]);
      } else {
        await exec([
          "gh",
          "pr",
          "create",
          "--repo",
          repository,
          "--head",
          change.branch,
          "--base",
          baseBranch,
          "--title",
          work.issue.title,
          "--body-file",
          body,
        ]);
      }
      const response = await exec([
        "gh",
        "pr",
        "view",
        change.branch,
        "--repo",
        repository,
        "--json",
        "number,url,state,headRefOid",
      ]);
      const pr = prSchema.parse(JSON.parse(response.stdout));
      if (pr.headRefOid !== change.revision) {
        throw new Error("The remote head does not match the approved commit.");
      }
      const next = await recordEvent(
        {
          ...work,
          pullRequest: {
            number: pr.number,
            revision: change.revision,
            url: pr.url,
          },
          status: "pr-open",
        },
        run.id,
        "pull request",
        `${pr.url}\nCommit: ${change.revision}`
      );
      report.result({
        body: pr.url,
        title: `Issue #${work.issue.number} ready for repository review`,
      });
      return next;
    } catch (error) {
      await recordEvent(work, run.id, "publication interrupted", String(error));
      throw error;
    } finally {
      await rm(folder, { force: true, recursive: true });
    }
  });
