import { step, tasks, workflow } from "@foundry.sh/marbles";
import { z } from "zod";
import { sendBack } from "./revise";
import { changeInput } from "./work";

const candidate = changeInput.extend({ evidence: z.string() });
const decision = z.object({ approved: z.boolean(), note: z.string() });

const approve = step("factory-approve")
  .input(candidate)
  .do(async ({ input, ask }) => {
    const task = await tasks.get(input.task);
    const answer = await ask.approval({
      body: `Branch ${input.branch}, verified in artifact version ${input.evidence}. Approval pushes this commit and opens or updates its pull request.`,
      title: `Ship "${task?.title ?? input.task}" at ${input.commit.slice(0, 8)}?`,
    });
    return { approved: answer.approved, note: answer.note ?? "" };
  });

const ship = step("factory-ship")
  .input(candidate.extend({ decision }))
  .do(async ({ input, exec }) => {
    if (!input.decision.approved) {
      await sendBack(input.task, `Declined at review: ${input.decision.note}`);
      return { shipped: false };
    }
    const head = (await exec(["git", "rev-parse", input.branch])).stdout.trim();
    if (head !== input.commit) {
      throw new Error("The branch moved after approval.");
    }
    await exec(["git", "push", "--set-upstream", "origin", input.branch]);
    const open = await exec(
      ["gh", "pr", "view", input.branch, "--json", "url", "--jq", ".url"],
      { check: false }
    );
    const title = (await tasks.get(input.task))?.title ?? input.branch;
    const url =
      open.exitCode === 0
        ? open.stdout.trim()
        : (
            await exec([
              "gh",
              "pr",
              "create",
              "--head",
              input.branch,
              "--title",
              title,
              "--body",
              `Verified at ${input.commit}.`,
            ])
          ).stdout.trim();
    await tasks.update(input.task, { metadata: { pullRequest: url } });
    await tasks.complete(input.task);
    return { pullRequest: url, shipped: true };
  });

export const deliver = workflow("factory-deliver")
  .input(candidate)
  .do(({ input }) => ship({ decision: approve({}, input) }, input));
