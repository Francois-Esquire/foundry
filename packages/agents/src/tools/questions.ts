import { tool } from "ai";
import { z } from "zod";

/**
 * Questionnaire tool: lets an agent ask the user one or more questions and
 * collect the answers, blocking the turn until they reply.
 *
 * `ask_questions` is declared **schema-only** (no `execute`). When the model
 * calls it the harness pauses the loop and surfaces the call to the renderer,
 * which translates the questionnaire (the tool's *input*) into a form (see
 * `@foundry/ui/generator`). The user's answers are posted back as the tool's
 * *output* — an {@link Answers} keyed by question id — which resumes the loop,
 * so the model reads them inline on the same turn. This is the standard AI SDK
 * human-in-the-loop pattern (same pause/resume the sandbox + preview tools use).
 */

/**
 * Sentinel option value for the free-text "Other" choice on single/multiple
 * questions. When `allowOther` is set, the renderer adds a choice with this
 * value; the typed text rides on the answer's `other` field, not in `options`.
 */
export const OTHER_VALUE = "__other__";

const choiceSchema = z.object({
  label: z.string().describe("Human-readable choice text."),
  value: z.string().describe("Stable value stored when this choice is picked."),
});

const baseFields = {
  description: z
    .string()
    .optional()
    .describe("Optional helper text under the prompt."),
  id: z.string().describe("Stable, unique id for this question."),
  prompt: z.string().describe("The question shown to the user."),
  required: z
    .boolean()
    .optional()
    .describe("Whether an answer is required before the form can submit."),
};

const questionSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseFields,
    allowOther: z
      .boolean()
      .optional()
      .describe("Add a free-text 'Other' choice the user can fill in."),
    options: z.array(choiceSchema).min(1),
    type: z.literal("single"),
  }),
  z.object({
    ...baseFields,
    allowOther: z
      .boolean()
      .optional()
      .describe("Add a free-text 'Other' choice the user can fill in."),
    options: z.array(choiceSchema).min(1),
    type: z.literal("multiple"),
  }),
  z.object({
    ...baseFields,
    placeholder: z.string().optional(),
    type: z.literal("text"),
  }),
]);

export const questionnaireSchema = z.object({
  description: z.string().optional(),
  id: z.string().describe("Stable id for this questionnaire."),
  questions: z.array(questionSchema).min(1),
  title: z.string().optional(),
});

export type Choice = z.infer<typeof choiceSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Questionnaire = z.infer<typeof questionnaireSchema>;

/** Collected answer for a single question, discriminated by question type. */
export type Answer =
  | { type: "single"; value: string | null; other?: string }
  | { type: "multiple"; values: string[]; other?: string }
  | { type: "text"; value: string };

/**
 * All answers for a questionnaire, keyed by question id. This is the tool's
 * output — what the renderer posts back and the model reads on resume.
 */
export type Answers = Record<string, Answer>;

const ASK_QUESTIONS_DESCRIPTION = `Ask the user one or more questions and collect their answers.
WHEN TO USE: you need a decision or input from the user before continuing —
  preferences, choices, or free-text details that you cannot infer.
QUESTION TYPES: 'single' (pick one), 'multiple' (pick any), 'text' (free text).
  For 'single'/'multiple', set allowOther:true to add a fill-in 'Other' choice.
DO NOT USE FOR: rhetorical questions or things you can answer yourself.`;

/**
 * Build the `ask_questions` tool. Schema-only by design — see the file header.
 * Returned in a `{ tools }` map so callers spread it into an agent's toolset
 * the same way as the other tool factories.
 */
export function createQuestions() {
  return {
    tools: {
      ask_questions: tool({
        description: ASK_QUESTIONS_DESCRIPTION,
        inputSchema: questionnaireSchema,
      }),
    },
  };
}
