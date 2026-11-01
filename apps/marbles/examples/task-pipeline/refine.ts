import { defineSkill, type Task } from "@foundry.sh/marbles";
import { z } from "zod";
import type { TaskBrief } from "./route";
import type { Refinement } from "./state";

/**
 * Refinement establishes what a task asks for. The model investigates and
 * reports; the pipeline, not the model, decides whether that is enough to
 * prepare the task, by the explicit rule in `promotion`.
 */

/** The refiner's reply. Every field is required, so `--dry-run` answers "not ready". */
export const refinementReplySchema = z.object({
  acceptance: z
    .array(z.string())
    .describe("Observable checks that show the task is done."),
  constraints: z
    .array(z.string())
    .describe("Limits the work must respect: scope, compatibility, rules."),
  ready: z
    .boolean()
    .describe(
      "True only when the task can be executed and verified without more input."
    ),
  requirements: z.array(z.string()).describe("What must be true afterwards."),
  summary: z.string().describe("The task in one or two sentences."),
  unknowns: z.array(
    z.object({
      assumption: z
        .string()
        .describe(
          "The safe assumption taken, for an inconsequential unknown; empty otherwise."
        ),
      consequential: z
        .boolean()
        .describe(
          "True when guessing would decide product behavior, an API, data, security, cost, or scope the requester has not decided."
        ),
      question: z.string(),
    })
  ),
});
export type RefinementReply = z.output<typeof refinementReplySchema>;

export const REFINER_PROMPT = [
  "You refine a rough task into a specification someone else will execute.",
  "Investigate the repository read-only as far as you need: do not edit files, run builds, or change anything.",
  "Establish what must be done: requirements, constraints, and acceptance criteria. Do not decide how it will be executed or by which workflow.",
  "List every unknown. Mark it consequential when answering it yourself would decide product behavior, an API, data, security, cost, or scope that the requester has not decided. Never guess a consequential answer; ask it. For an inconsequential unknown, record the safe assumption you took.",
].join("\n");

/** The default skill the refiner works with; a pipeline may choose others. */
export const refinementSkill = defineSkill({
  manifest: `---
name: task-refinement
description: Turn a rough task into requirements, constraints, and acceptance criteria without deciding product questions.
---
1. Restate the task's goal in one or two sentences.
2. Read the code and docs the task names, and the instructions that govern them (AGENTS.md, CLAUDE.md), before stating requirements.
3. Each requirement is one verifiable statement about the result.
4. Each acceptance criterion names a check a reviewer can run or read: a test, a command, an observable behavior.
5. Constraints come from the repository's rules and the task's own words, not from preference.
6. When two reasonable readings lead to different user-visible results, that is a consequential unknown.
`,
});

export interface Promotion {
  readonly promoted: boolean;
  readonly questions: string[];
  readonly reason: string;
}

/**
 * Whether a refinement prepares the task. All must hold: the refiner says
 * it is ready, there is at least one requirement and one acceptance
 * criterion, and no unknown is consequential. Otherwise the task waits
 * for its requester, with the consequential questions to answer.
 */
export function promotion(reply: RefinementReply): Promotion {
  const questions = reply.unknowns
    .filter((unknown) => unknown.consequential)
    .map((unknown) => unknown.question);
  const missing = [
    reply.ready ? undefined : "the refiner did not mark it ready",
    reply.requirements.length > 0 ? undefined : "it has no requirements",
    reply.acceptance.length > 0 ? undefined : "it has no acceptance criteria",
    questions.length === 0
      ? undefined
      : `${String(questions.length)} consequential question(s) are open`,
  ].filter((reason) => reason !== undefined);
  return missing.length === 0
    ? {
        promoted: true,
        questions: [],
        reason:
          "Ready, with requirements, acceptance criteria, and no consequential unknowns.",
      }
    : {
        promoted: false,
        questions,
        reason: `Not prepared: ${missing.join("; ")}.`,
      };
}

export function refinementOf(
  reply: RefinementReply,
  verdict: Promotion,
  session: { readonly id: string; readonly provider?: string }
): Refinement {
  return {
    ...reply,
    promoted: verdict.promoted,
    reason: verdict.reason,
    session: session.id,
    ...(session.provider === undefined ? {} : { provider: session.provider }),
  };
}

export function refinePrompt(task: Task): string {
  return [`Task ${task.id}: ${task.title}`, task.description ?? ""]
    .filter(Boolean)
    .join("\n\n");
}

/** The task as one specification, with its refinement when there is one. */
export function briefOf(task: Task, refinement?: Refinement): TaskBrief {
  const list = (title: string, items: readonly string[]) =>
    items.length === 0
      ? ""
      : `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
  const assumptions = (refinement?.unknowns ?? [])
    .filter((unknown) => !unknown.consequential && unknown.assumption)
    .map((unknown) => `${unknown.question} → ${unknown.assumption}`);
  const spec = [
    `Task ${task.id}: ${task.title}`,
    task.description ?? "",
    refinement?.summary ?? "",
    list("Requirements", refinement?.requirements ?? []),
    list("Constraints", refinement?.constraints ?? []),
    list("Acceptance criteria", refinement?.acceptance ?? []),
    list("Assumptions", assumptions),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    description: task.description,
    id: task.id,
    spec,
    title: task.title,
    ...(refinement === undefined ? {} : { refinement }),
  };
}
