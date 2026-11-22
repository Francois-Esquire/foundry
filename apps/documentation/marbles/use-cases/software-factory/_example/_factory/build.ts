import { agent, step } from "@foundry.sh/marbles";
import { branchOf, brief, workInput } from "./work";

const builder = agent({
  name: "factory-builder",
  prompt:
    "Plan the change against the task and its acceptance criteria, then implement it with focused tests. Address every finding from the last attempt. Follow the repository's instructions. Commit your work. Do not push.",
});

export const build = step("factory-build")
  .input(workInput)
  .config({ timeout: "30m" })
  .do(async ({ input, agents, exec, workspaces }) => {
    const branch = branchOf(input.task);
    const { git } = workspaces.current;
    const revising = await git.hasBranch(branch);
    return await git.withWorktree(
      revising ? { base: branch } : { base: "HEAD", branch },
      async () => {
        if (revising) {
          await exec(["git", "switch", branch]);
        }
        const start = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim();
        const session = await agents.session(builder);
        await session.generate(await brief(input.task));
        const head = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim();
        const dirty = (
          await exec(["git", "status", "--porcelain"])
        ).stdout.trim();
        if (head === start || dirty) {
          throw new Error("Expected a new commit and a clean checkout.");
        }
        return head;
      }
    );
  });
