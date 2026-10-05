import { agent, step, workflow } from "@foundry/marbles";
import { z } from "zod";

/**
 * Example compositions, written in the same dialect a configuration module
 * uses. If one of these cannot be said with the lib, the lib is missing
 * something. That is the point of writing them this way.
 *
 * Every agent turn goes through `agents.session`: the working directory,
 * cancellation, and streaming are wired by the context, so the steps below
 * are about the work only.
 */

const PASS = "PASS";

const VERDICT_PROTOCOL = `Reply with exactly "${PASS}" on a line of its own if you find nothing worth changing. Otherwise list one finding per line, no preamble.`;

/** Read a review turn's text as a verdict. `PASS` anywhere alone means clean. */
export function findingsIn(reviewText: string): readonly string[] {
  const lines = reviewText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.some((line) => line === PASS)) {
    return [];
  }
  return lines;
}

const implementer = agent({
  prompt:
    "Implement the task in this working tree. Keep changes small and report what you changed.",
});

const reviewer = agent({
  prompt:
    "You review code. Read only; never edit, commit, or run anything that changes the tree.",
});

// ── develop ──────────────────────────────────────────────────────────────

const task = z.object({
  cwd: z.string().default("."),
  task: z.string(),
});

export const implement = step("implement")
  .input(task)
  .output(z.string())
  .do(async ({ agents, input }) => {
    const session = await agents.session(implementer, { cwd: input.cwd });
    return (await session.generate(input.task)).text;
  });

export const review = step("review")
  .input(task.extend({ implemented: z.string() }))
  .output(z.object({ findings: z.array(z.string()), text: z.string() }))
  .do(async ({ agents, input }) => {
    const session = await agents.session(reviewer, { cwd: input.cwd });
    const { text } = await session.generate(
      `Review the uncommitted changes in this working tree against the task: ${input.task}\n\nThe implementer reported:\n${input.implemented}\n\n${VERDICT_PROTOCOL}`
    );
    return { findings: [...findingsIn(text)], text };
  });

/** Implement, then review what was implemented. The reviewer runs last. */
export const developRound = workflow("develop-round")
  .input(task)
  .do(({ input }) => review({ implemented: implement({}, input) }, input));

// ── review ───────────────────────────────────────────────────────────────

const revision = z.object({
  base: z.string(),
  repository: z.string(),
});

const reviewPrompt = (base: string) =>
  `Review the code in this working tree, checked out from ${base}. Report what you would change, most important first.`;

/**
 * A review inside a throwaway worktree. The session opened in the callback
 * runs in the worktree: the context narrows the working directory for it.
 */
export const reviewInWorktree = step("review-in-worktree")
  .input(revision)
  .do(async ({ agents, input, log, workspaces }) => {
    const repository = await workspaces.load({ path: input.repository });
    return repository.git.withWorktree(
      { base: input.base },
      async (worktree) => {
        log(`reviewing in ${worktree.root}`);
        const session = await agents.session(reviewer);
        const { text } = await session.generate(reviewPrompt(input.base));
        return { review: text, root: worktree.root };
      }
    );
  });

// ── review-session ───────────────────────────────────────────────────────

/** One session per base, so a scheduled review remembers what it said last time. */
export const reviewSession = step("review-session")
  .input(revision)
  .do(async ({ agents, input, workspaces }) => {
    const repository = await workspaces.load({ path: input.repository });
    return repository.git.withWorktree({ base: input.base }, async () => {
      const session = await agents.session(reviewer, {
        session: { id: `review-${input.base}` },
      });
      const { text } = await session.generate(
        `${reviewPrompt(input.base)} Only mention what changed since you last looked.`
      );
      return { sessionId: session.ref.id, text };
    });
  });
