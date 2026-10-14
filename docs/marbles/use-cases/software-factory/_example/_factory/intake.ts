import { step } from "@foundry.sh/marbles";
import {
  baseBranch,
  issueInput,
  issueSchema,
  newRecord,
  readRecord,
  recordEvent,
  recordSchema,
  repository,
} from "./record";

const acceptanceSection =
  /^## Acceptance criteria\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m;
const checkbox = /^- \[[ xX]\] (.+)$/gm;

export const intake = step("factory-intake")
  .input(issueInput)
  .output(recordSchema)
  .do(async ({ input, exec, run }) => {
    const existing = await readRecord(input.issue);
    if (existing && existing.status !== "triaged") {
      const needsNewIntake =
        existing.status === "blocked" && existing.attempts === 0;
      if (!needsNewIntake) {
        if (["blocked", "implementing"].includes(existing.status)) {
          throw new Error(
            "Inspect the partial attempt before continuing this issue."
          );
        }
        return existing;
      }
    }
    const localRepo = (
      await exec([
        "gh",
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
      ])
    ).stdout.trim();
    if (localRepo.toLowerCase() !== repository.toLowerCase()) {
      throw new Error("The checkout does not match the configured repository.");
    }
    const result = await exec([
      "gh",
      "issue",
      "view",
      String(input.issue),
      "--repo",
      repository,
      "--json",
      "number,title,body,url,updatedAt,state",
    ]);
    const issue = issueSchema.parse(JSON.parse(result.stdout));
    if (issue.state !== "OPEN") {
      throw new Error("Choose an open issue.");
    }
    const section = acceptanceSection.exec(issue.body)?.[1] ?? "";
    const acceptance = [...section.matchAll(checkbox)].map(
      (match) => match[1] ?? ""
    );
    if (!acceptance.length) {
      throw new Error(
        "Add checkboxes under ## Acceptance criteria to the issue."
      );
    }
    await exec(["git", "fetch", "origin"]);
    const base = (
      await exec([
        "git",
        "rev-parse",
        "--verify",
        `origin/${baseBranch}^{commit}`,
      ])
    ).stdout.trim();
    const record = {
      ...(existing ?? newRecord(issue, base)),
      acceptance,
      base,
      issue,
      status: "queued" as const,
    };
    return recordEvent(
      record,
      run.id,
      "intake",
      `Captured issue ${issue.updatedAt} at ${base}.`,
      {
        "issue.md": issue.body,
      }
    );
  });
