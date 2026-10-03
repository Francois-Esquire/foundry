import type {
  HarnessPermissionResult,
  HarnessQuestion,
  HarnessQuestionResult,
} from "@foundry/agents/harness";
import { z } from "zod";
import type { DriverRun } from "./shared";

const optionSchema = z.object({
  description: z.string().optional(),
  label: z.string().min(1),
});
const questionSchema = z.object({
  header: z.string().optional(),
  id: z.string().min(1).optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(optionSchema).nullable().optional(),
  question: z.string().min(1),
});

/** Native protocols differ in question identity and answer representation. */
export function nativeQuestions(
  input: unknown,
  toolCallId: string,
  native: "claude" | "codex"
): HarnessQuestion[] {
  const parsed = z
    .array(questionSchema)
    .min(1)
    .max(native === "claude" ? 4 : 3)
    .parse(input);
  const questions = parsed.map((question, index) => {
    const id = native === "claude" ? `${toolCallId}:${index}` : question.id;
    if (!id) {
      throw new Error("Native question identifiers must be present.");
    }
    return { ...question, id, options: question.options ?? undefined };
  });
  if (
    new Set(questions.map((question) => question.id)).size !==
      questions.length ||
    (native === "claude" &&
      new Set(questions.map((question) => question.question)).size !==
        questions.length)
  ) {
    throw new Error("Native question identifiers must be present and unique.");
  }
  return questions;
}

/** Cancel an in-process question even when the host callback ignores its signal. */
export async function askQuestions(
  run: DriverRun,
  toolCallId: string,
  questions: HarnessQuestion[],
  signal: AbortSignal
): Promise<HarnessQuestionResult> {
  signal.throwIfAborted();
  let cancel: () => void = () => undefined;
  const canceled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new DOMException("Question canceled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    const result = await Promise.race([
      run.question({ questions, sessionId: run.sessionId, signal, toolCallId }),
      canceled,
    ]);
    signal.throwIfAborted();
    if (result.outcome === "answered") {
      for (const question of questions) {
        const answer = result.answers[question.id];
        if (
          !Array.isArray(answer) ||
          answer.length === 0 ||
          answer.some((value) => typeof value !== "string" || !value.trim()) ||
          (!question.multiSelect && answer.length > 1)
        ) {
          return {
            outcome: "declined",
            reason: "Question answer is missing or invalid.",
          };
        }
      }
    }
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function answerClaudeQuestion(
  run: DriverRun,
  toolCallId: string,
  input: Record<string, unknown>,
  signal: AbortSignal
): Promise<HarnessPermissionResult> {
  const questions = nativeQuestions(input.questions, toolCallId, "claude");
  const result = await askQuestions(run, toolCallId, questions, signal);
  if (result.outcome === "declined") {
    return { behavior: "deny", message: result.reason };
  }
  const answers: Record<string, string> = {};
  for (const question of questions) {
    answers[question.question] = (result.answers[question.id] ?? []).join(", ");
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
}
