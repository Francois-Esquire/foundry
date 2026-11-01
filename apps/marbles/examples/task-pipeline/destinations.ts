import { agent, step } from "@foundry.sh/marbles";
import { z } from "zod";
import { adversarialReview } from "../adversarial-review";
import { developRound } from "../development";
import { type Destination, destination } from "./route";

/**
 * The destinations this repository offers a prepared task: review of a
 * change, implementation, and read-only research. Review and
 * implementation are the existing `adversarial-review` and `develop-round`
 * workflows; nothing else took a free question, so research is a small
 * step here.
 */

const MAX_RESEARCH_MS = 900_000;

const researcher = agent({
  name: "task-researcher",
  prompt:
    "You research a question about this repository. Read only: do not edit files, install dependencies, or run builds. Answer with what you found, file references for each claim, and what you could not establish.",
});

export const research = step("task-research")
  .describe(
    "Investigate a question about the repository read-only and report findings."
  )
  .input(
    z.object({
      question: z.string().trim().min(1),
      worktree: z.string().trim().min(1).default("."),
    })
  )
  .config({ timeout: MAX_RESEARCH_MS })
  .do(async ({ agents, input }) => {
    const session = await agents.session(researcher, { cwd: input.worktree });
    const reply = await session.generate(input.question);
    return {
      findings: reply.text,
      provider: session.ref.provider ?? null,
      session: session.ref.id,
    };
  });

export interface StandardDestinationOptions {
  /** The checkout each destination works in. Default the workspace root. */
  readonly worktree?: string;
}

export function standardDestinations(
  options: StandardDestinationOptions = {}
): Destination[] {
  const worktree = options.worktree ?? ".";
  return [
    destination({
      build: (brief, chosen) => ({ ...chosen, spec: brief.spec, worktree }),
      choose: z.object({
        base: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("The branch or commit the change is reviewed from."),
        includeWorkingTree: z
          .boolean()
          .optional()
          .describe("Also review uncommitted changes."),
      }),
      definition: adversarialReview,
      description:
        "Review an existing change against the repository's standards and against the task as its spec. Reads only.",
    }),
    destination({
      build: (brief) => ({ cwd: worktree, task: brief.spec }),
      choose: z.object({}),
      definition: developRound,
      description:
        "Implement the task in the working tree, then review what was implemented. Edits files.",
    }),
    destination({
      build: (brief) => ({ question: brief.spec, worktree }),
      choose: z.object({}),
      definition: research,
      description:
        "Investigate a question about the codebase and report findings with file references. Reads only.",
    }),
  ];
}
