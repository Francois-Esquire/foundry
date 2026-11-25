import type { HarnessQuestionToolSettings } from "@foundry/core/agents";
import { markHarnessQuestionExecutor } from "@foundry/core/agents";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";

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
    .min(1),
});

export function createTestQuestionTool(
  settings: HarnessQuestionToolSettings
): Tool {
  const result = tool({
    description: "Ask the user for information.",
    execute: async (input, options) => {
      const signal = options.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      if (!settings.question) {
        return {
          outcome: "declined" as const,
          reason: "No host question handler is configured.",
        };
      }
      const ctx = options.context;
      const activityId =
        typeof ctx === "object" &&
        ctx !== null &&
        "activityId" in ctx &&
        typeof ctx.activityId === "string"
          ? ctx.activityId
          : undefined;
      return await settings.question({
        ...(activityId === undefined ? {} : { activityId }),
        questions: input.questions,
        sessionId: settings.sessionId,
        signal,
        toolCallId: options.toolCallId,
      });
    },
    inputSchema: questionsSchema,
  });
  markHarnessQuestionExecutor(result.execute);
  return result;
}
