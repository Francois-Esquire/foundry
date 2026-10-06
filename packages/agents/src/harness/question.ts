import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";

import { raceAbort } from "./abortable";

import type {
  HarnessQuestionCallback,
  HarnessQuestionRequest,
  HarnessQuestionResult,
} from "./turn-driver";

const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        header: z.string().optional(),
        id: z.string().min(1),
        multiSelect: z.boolean().optional(),
        options: z
          .array(
            z.object({
              description: z.string().optional(),
              label: z.string().min(1),
            })
          )
          .min(1)
          .optional(),
        question: z.string().min(1),
      })
    )
    .min(1)
    .refine(
      (questions) =>
        new Set(questions.map((question) => question.id)).size ===
        questions.length,
      {
        message: "Question ids must be unique.",
      }
    ),
});

const questionExecutors = new WeakSet<NonNullable<Tool["execute"]>>();

/** Only the shared communication factory bypasses effect permission checks. */
export function isHarnessQuestionTool(candidate: Tool): boolean {
  return (
    candidate.execute !== undefined && questionExecutors.has(candidate.execute)
  );
}

export interface HarnessQuestionToolSettings {
  question?: HarnessQuestionCallback;
  sessionId: string;
}

/** Raw answers enter the model's tool-result history, like other user input.
 * Hosts must avoid logging the callback request or answer values. */
export function createHarnessQuestionTool(
  settings: HarnessQuestionToolSettings
): Tool {
  const question = createHarnessQuestionCallback(settings);
  const result = tool({
    description:
      "Ask the user for information or a decision needed to continue. A declined response is not an answer or permission grant.",
    execute: async (input, options) =>
      await question({
        questions: input.questions,
        ...questionActivity(options.context),
        sessionId: settings.sessionId,
        signal: options.abortSignal ?? new AbortController().signal,
        toolCallId: options.toolCallId,
      }),
    inputSchema: questionsSchema,
  });
  questionExecutors.add(result.execute);
  return result;
}

type QuestionOutcome = "requested" | "answered" | "declined" | "interrupted";

interface QuestionCallbackSettings extends HarnessQuestionToolSettings {
  record?: (
    request: HarnessQuestionRequest,
    outcome: QuestionOutcome,
    answerCount?: number
  ) => Promise<void>;
  signal?: AbortSignal | (() => AbortSignal | undefined);
}

export function createHarnessQuestionCallback(
  settings: QuestionCallbackSettings
): HarnessQuestionCallback {
  return async (input) => {
    const hostSignal =
      typeof settings.signal === "function"
        ? settings.signal()
        : settings.signal;
    const signal = hostSignal
      ? AbortSignal.any([hostSignal, input.signal])
      : input.signal;
    signal.throwIfAborted();
    const request = {
      ...input,
      ...questionsSchema.parse(input),
      sessionId: settings.sessionId,
      signal,
    };
    try {
      await settings.record?.(request, "requested");
      signal.throwIfAborted();
      const { question } = settings;
      const result = question
        ? await waitForAnswer(
            Promise.resolve().then(() => question(request)),
            signal
          )
        : {
            outcome: "declined" as const,
            reason: "No host question handler is configured.",
          };
      signal.throwIfAborted();
      validateAnswer(request, result);
      const answerCount =
        result.outcome === "answered"
          ? Object.values(result.answers).reduce(
              (count, answers) => count + answers.length,
              0
            )
          : undefined;
      await settings.record?.(request, result.outcome, answerCount);
      return result;
    } catch (error) {
      await settings.record?.(
        request,
        signal.aborted ? "interrupted" : "declined"
      );
      throw error;
    }
  };
}

function validateAnswer(
  request: HarnessQuestionRequest,
  result: HarnessQuestionResult
): void {
  if (result.outcome === "declined") {
    if (typeof result.reason !== "string" || result.reason.length === 0) {
      throw new Error("A declined question needs a reason.");
    }
    return;
  }
  if (
    result.outcome !== "answered" ||
    !result.answers ||
    typeof result.answers !== "object"
  ) {
    throw new Error("Invalid host question response.");
  }
  const ids = new Set(request.questions.map((question) => question.id));
  if (Object.keys(result.answers).some((id) => !ids.has(id))) {
    throw new Error("Host answered an unknown question.");
  }
  for (const question of request.questions) {
    const answers = result.answers[question.id];
    if (
      !Array.isArray(answers) ||
      answers.length === 0 ||
      answers.some(
        (answer) => typeof answer !== "string" || answer.length === 0
      )
    ) {
      throw new Error("Host did not answer every question.");
    }
    if (!question.multiSelect && answers.length !== 1) {
      throw new Error(
        "Host supplied multiple answers to a single-choice question."
      );
    }
  }
}

async function waitForAnswer(
  pending: Promise<HarnessQuestionResult>,
  signal: AbortSignal
): Promise<HarnessQuestionResult> {
  try {
    return await raceAbort(pending, signal);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    // Host exceptions may echo credentials or answer values into the transcript.
    // biome-ignore lint/style/useErrorCause: Original exceptions may contain secrets and must not reach host event logs.
    throw new Error("Host question handler failed.");
  }
}

function questionActivity(context: unknown): { activityId?: string } {
  if (
    typeof context !== "object" ||
    context === null ||
    !("activityId" in context) ||
    typeof context.activityId !== "string"
  ) {
    return {};
  }
  return { activityId: context.activityId };
}
