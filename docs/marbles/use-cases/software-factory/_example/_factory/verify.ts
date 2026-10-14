import { agent, Output, step } from "@foundry/marbles";
import {
  chronicle,
  recordEvent,
  recordSchema,
  requireRecord,
  reviewSchema,
  workInput,
} from "./record";

const reviewer = agent({
  prompt:
    "Review the exact candidate commit against the original issue, acceptance criteria, plan, implementation explanation, and prior findings. Read repository instructions and relevant callers. Check the code yourself. Examine new packages and dependencies for necessity, ownership, version and lockfile consistency. Check module interfaces, domain invariants, failure handling, and whether tests exercise the required results. For each criterion, name concrete evidence or mark it unmet. Mark promised but unperformed checks as missing evidence. Each blocker needs a file or record reference, a triggering condition, and a consequence. Separate defects from preferences and identify findings the revision already resolved. Do not invent requirements. Do not edit or commit.",
});
export const verify = step("factory-verify")
  .input(workInput)
  .output(recordSchema)
  .do(async ({ input: { work }, agents, workspaces, exec, run }) => {
    const { change } = work;
    if (
      change &&
      work.verification?.revision === change.revision &&
      work.status !== "implemented"
    ) {
      return work;
    }
    if (!change || work.status !== "implemented") {
      throw new Error("An implemented candidate is required.");
    }
    try {
      return await workspaces.current.git.withWorktree(
        { base: change.revision },
        async () => {
          const install = await exec(["bun", "install", "--frozen-lockfile"], {
            check: false,
          });
          const tests =
            install.exitCode === 0
              ? await exec(["bun", "test"], { check: false })
              : {
                  exitCode: -1,
                  stderr: "Tests not run because installation failed.",
                  stdout: "",
                };
          const output = JSON.stringify({ install, tests }, null, 2);
          const checked = await recordEvent(
            work,
            run.id,
            "test output",
            output,
            {
              [`attempts/${work.attempts}/tests.json`]: output,
            }
          );
          const session = await agents.session(
            reviewer,
            work.reviewer ? { session: work.reviewer } : {}
          );
          const reply = await session.generate(
            [
              work.issue.body,
              chronicle(checked),
              `Review ${work.base}..${change.revision}. Initial implementation and all later attempts are in the history.`,
              `Implementation explanation: ${change.summary}`,
            ].join("\n\n"),
            { output: Output.object({ schema: reviewSchema }) }
          );
          const review = reviewSchema.parse(reply.output);
          const head = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim();
          const dirty = (
            await exec(["git", "status", "--porcelain"])
          ).stdout.trim();
          if (head !== change.revision || dirty) {
            throw new Error(
              "Verification changed the checkout. Its evidence cannot be accepted."
            );
          }
          const testsPassed = install.exitCode === 0 && tests.exitCode === 0;
          const meetsCriteria = work.acceptance.every((criterion) =>
            review.criteria.some(
              (item) =>
                item.criterion === criterion && item.met && item.evidence.trim()
            )
          );
          return recordEvent(
            {
              ...checked,
              reviewer: session.ref,
              status:
                testsPassed && meetsCriteria && review.blockers.length === 0
                  ? "verified"
                  : "needs-changes",
              verification: { review, revision: change.revision, testsPassed },
            },
            run.id,
            "review",
            JSON.stringify(review, null, 2)
          );
        }
      );
    } catch (error) {
      // Read the latest record so a failure after testing keeps its output.
      const latest = await requireRecord(work.issue.number);
      await recordEvent(
        { ...latest, status: "blocked" },
        run.id,
        "verification failed",
        String(error)
      );
      throw error;
    }
  });
