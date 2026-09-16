import type {
  LoopUntilResult,
  ModelManager,
  TurnExecutorRef,
  Worktree,
} from "@foundry/quirks";
import { agent, loopUntil, step, workflow } from "@foundry/quirks";
import { generateText } from "ai";

/**
 * The built-in workflows, written in the same dialect a `quirks.config.ts`
 * uses. If one of these cannot be said with the lib, the lib is missing
 * something — that is the point of writing them this way.
 *
 * One-shot turns are a `generateText` against a CLI-harness model: the harness
 * runs its own agentic loop, so there is nothing to wrap. A turn that should
 * remember the last run goes through `agents.session()` instead.
 */

const PASS = "PASS";

const VERDICT_PROTOCOL = `Reply with exactly "${PASS}" on a line of its own if you find nothing worth changing. Otherwise list one finding per line, no preamble.`;

/** Read a review turn's text as a verdict. `PASS` anywhere alone means clean. */
export function findingsIn(review: string): readonly string[] {
  const lines = review
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.some((line) => line === PASS)) {
    return [];
  }
  return lines;
}

// ── develop ──────────────────────────────────────────────────────────────

export interface DevelopInput {
  readonly cwd: string;
  readonly findings: readonly string[];
  /** Threaded through input because the loop does not put it in context. */
  readonly round: number;
  readonly task: string;
}

export interface DevelopRoundOutput {
  readonly findings: readonly string[];
  readonly implemented: string;
  readonly review: string;
}

interface TurnInput {
  readonly cwd: string;
  readonly prompt: string;
}

interface TurnOutput {
  readonly text: string;
}

async function ask(
  models: ModelManager,
  executor: TurnExecutorRef,
  input: TurnInput
): Promise<TurnOutput> {
  const { text } = await generateText({
    model: models.model(executor.model, executor.provider, {
      workingDirectory: input.cwd,
    }),
    prompt: input.prompt,
  });
  return { text };
}

function executorAt(executors: readonly TurnExecutorRef[], index: number) {
  const executor = executors[index] ?? executors[0];
  if (!executor) {
    throw new Error("quirks: no executor available");
  }
  return executor;
}

const implement = step("implement", ({ models, executors }, input: TurnInput) =>
  ask(models, executorAt(executors, 0), input)
);

/** A second harness reviews when there is one; otherwise the implementer does. */
const review = step("review", ({ models, executors }, input: TurnInput) =>
  ask(models, executorAt(executors, 1), input)
);

export const developRound = workflow<DevelopInput, DevelopRoundOutput>(
  "develop-round",
  (graph) => {
    graph
      .step("implement", implement, ({ input }) => ({
        cwd: input.cwd,
        prompt:
          input.findings.length === 0
            ? input.task
            : `Round ${String(input.round)}. ${input.task}\n\nA review of your last round raised these; address them:\n${input.findings.join("\n")}`,
      }))
      .step("review", review, ({ input, implement }) => ({
        cwd: input.cwd,
        prompt: `Review the uncommitted changes in this working tree against the task: ${input.task}\n\nThe implementer reported:\n${implement.text}\n\n${VERDICT_PROTOCOL}`,
      }))
      .output(({ implement, review }) => ({
        findings: findingsIn(review.text),
        implemented: implement.text,
        review: review.text,
      }));
  }
);

export type DevelopOutput = LoopUntilResult<DevelopRoundOutput>;

export const develop = workflow<DevelopInput, DevelopOutput>(
  "develop",
  (graph) => {
    graph
      .step(
        "loop",
        loopUntil<DevelopInput, DevelopRoundOutput>({
          body: developRound,
          maxRounds: 5,
          next: ({ output, round }, previous) => ({
            ...previous,
            findings: output.findings,
            round: round + 1,
          }),
          until: ({ output }) => output.findings.length === 0,
        }),
        ({ input }) => input
      )
      .output(({ loop }) => loop);
  }
);

// ── review ───────────────────────────────────────────────────────────────

export interface ReviewInput {
  readonly base: string;
  readonly repository: string;
}

const reviewPrompt = (base: string) =>
  `Review the code in this working tree, checked out from ${base}. Report what you would change, most important first.`;

export interface ReviewOutput {
  readonly reviews: readonly {
    readonly harness: string;
    readonly text: string;
  }[];
  readonly root: string;
}

/** Never catalogued as a Workspace: cataloguing hashes every file to reach the same snapshot. */
async function worktreeStatus(
  worktree: Worktree,
  base: string
): Promise<string> {
  const status = await worktree.status();
  const where = `[worktree] ${worktree.root}`;
  if (status.kind === "none") {
    return `${where}: no git`;
  }
  if (status.kind === "unavailable") {
    return `${where}: ${status.reason}`;
  }
  const head = status.branch ?? `detached at ${base}`;
  const tree =
    status.paths.length === 0
      ? "clean"
      : `${String(status.paths.length)} changed`;
  return `${where}: ${head} · ${tree}`;
}

/** One review per harness, concurrently, inside a throwaway worktree. */
export const reviewInWorktree = step(
  "review-in-worktree",
  ({ models, executors, workspaces, log }, input: ReviewInput) =>
    workspaces.git(input.repository).withWorktree(input, async (worktree) => {
      log(`reviewing in ${worktree.root}`);
      log(await worktreeStatus(worktree, input.base));
      const reviews = await Promise.all(
        executors.map(async (executor) => {
          const { text } = await generateText({
            model: models.model(executor.model, executor.provider, {
              workingDirectory: worktree.root,
            }),
            prompt: reviewPrompt(input.base),
          });
          return { harness: executor.harness, text };
        })
      );
      return { reviews, root: worktree.root } satisfies ReviewOutput;
    })
);

// ── review-session ───────────────────────────────────────────────────────

export const reviewer = agent("quirks-reviewer", {
  prompt:
    "You review code. Read only; never edit, commit, or run anything that changes the tree.",
});

export interface ReviewSessionOutput {
  readonly sessionId: string;
  readonly text: string;
}

/** One reviewer, one session per base, so a scheduled review remembers what it said last time. */
export const reviewSession = step(
  "review-session",
  ({ agents, workspaces, log }, input: ReviewInput) =>
    workspaces.git(input.repository).withWorktree(input, async (worktree) => {
      const sessionId = `review-${input.base}`;
      log(`reviewing in ${worktree.root} as ${sessionId}`);
      const session = await agents.session(reviewer, {
        cwd: worktree.root,
        sessionId,
      });
      const reply = await session.generate(
        `${reviewPrompt(input.base)} If this session holds an earlier review of yours, say what changed since then and what still stands.`
      );
      const text = reply.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      return { sessionId, text } satisfies ReviewSessionOutput;
    })
);
