import { agent, step } from "@foundry/marbles";
import {
  chronicle,
  maxAttempts,
  recordEvent,
  recordSchema,
  workInput,
} from "./record";

const implementer = agent({
  prompt:
    "Implement this issue and the recorded plan. Address the recorded revision request if present. Add or update focused tests for the plan where appropriate. Commit focused changes. Explain what you changed and why. Do not push or merge.",
});
export const implement = step("factory-implement")
  .input(workInput)
  .output(recordSchema)
  .do(async ({ input: { work }, agents, workspaces, exec, run }) => {
    if (work.change && work.status !== "planned") {
      return work;
    }
    if (work.status !== "planned" || !work.plan) {
      throw new Error("A resolved plan is required.");
    }
    if (work.attempts >= maxAttempts) {
      throw new Error("Attempt limit reached. Hand the issue to a person.");
    }
    const branch = work.change?.branch ?? `marbles/issue-${work.issue.number}`;
    const start = work.change?.revision ?? work.base;
    let next = await recordEvent(
      {
        ...work,
        attempts: work.attempts + 1,
        decision: undefined,
        status: "implementing",
        verification: undefined,
      },
      run.id,
      "implementation started",
      `Attempt ${work.attempts + 1}; branch ${branch}; base ${start}.`
    );
    try {
      const change = await workspaces.current.git.withWorktree(
        work.change ? { base: start } : { base: start, branch },
        async () => {
          if (work.change) {
            await exec(["git", "switch", branch]);
          }
          const before = (
            await exec(["git", "rev-parse", "HEAD"])
          ).stdout.trim();
          if (before !== start) {
            throw new Error(
              "The branch moved. Reconcile it with the work log first."
            );
          }
          const session = await agents.session(implementer);
          const reply = await session.generate(
            `${work.issue.body}\n\n${chronicle(next)}`
          );
          const revision = (
            await exec(["git", "rev-parse", "HEAD"])
          ).stdout.trim();
          const dirty = (
            await exec(["git", "status", "--porcelain"])
          ).stdout.trim();
          if (dirty || revision === start) {
            throw new Error("Expected a new commit and a clean checkout.");
          }
          await exec(["git", "merge-base", "--is-ancestor", start, revision]);
          return { branch, revision, summary: reply.text };
        }
      );
      next = await recordEvent(
        { ...next, change, status: "implemented" },
        run.id,
        "implementation completed",
        `Commit: ${change.revision}\n\n${change.summary}`
      );
      return next;
    } catch (error) {
      await recordEvent(
        { ...next, status: "blocked" },
        run.id,
        "implementation failed",
        String(error)
      );
      throw error;
    }
  });
