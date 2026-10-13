import { agent, Output, step } from "@foundry/marbles";
import {
  chronicle,
  planSchema,
  recordEvent,
  recordSchema,
  workInput,
} from "./record";

const planner = agent({
  prompt:
    "Inspect the repository without editing. Plan the requested issue against its acceptance criteria. Name the checks that will prove each criterion. List questions that prevent implementation. Do not invent missing requirements.",
});
export const plan = step("factory-plan")
  .input(workInput)
  .output(recordSchema)
  .do(async ({ input: { work }, agents, workspaces, run }) => {
    if (work.plan && work.plan.questions.length === 0) {
      return work;
    }
    const output = await workspaces.current.git.withWorktree(
      { base: work.base },
      async () => {
        const session = await agents.session(planner);
        const reply = await session.generate(
          `${work.issue.body}\n\n${chronicle(work)}`,
          {
            output: Output.object({ schema: planSchema }),
          }
        );
        return planSchema.parse(reply.output);
      }
    );
    const next = await recordEvent(
      {
        ...work,
        plan: output,
        status: output.questions.length ? "blocked" : "planned",
      },
      run.id,
      "plan",
      JSON.stringify(output, null, 2)
    );
    if (output.questions.length) {
      throw new Error(
        "Planning needs answers. Read the work log before continuing."
      );
    }
    return next;
  });
