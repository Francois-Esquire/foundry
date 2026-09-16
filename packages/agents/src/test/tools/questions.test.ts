import { describe, expect, it } from "vitest";

import type { Questionnaire } from "../../tools/questions";

import { createQuestions, questionnaireSchema } from "../../tools/questions";

const sample: Questionnaire = {
  id: "q1",
  questions: [
    {
      allowOther: true,
      id: "framework",
      options: [
        { label: "React", value: "react" },
        { label: "Vue", value: "vue" },
      ],
      prompt: "Which framework?",
      type: "single",
    },
    {
      id: "features",
      options: [
        { label: "Auth", value: "auth" },
        { label: "Database", value: "db" },
      ],
      prompt: "Which features?",
      type: "multiple",
    },
    { id: "notes", prompt: "Anything else?", type: "text" },
  ],
  title: "Project setup",
};

describe("questionnaireSchema", () => {
  it("accepts a well-formed questionnaire", () => {
    expect(questionnaireSchema.safeParse(sample).success).toBe(true);
  });

  it("rejects an unknown question type", () => {
    const bad = {
      id: "q",
      questions: [{ id: "x", options: [], prompt: "?", type: "slider" }],
    };
    expect(questionnaireSchema.safeParse(bad).success).toBe(false);
  });

  it("requires at least one option on choice questions", () => {
    const bad = {
      id: "q",
      questions: [{ id: "x", options: [], prompt: "?", type: "single" }],
    };
    expect(questionnaireSchema.safeParse(bad).success).toBe(false);
  });
});

describe("createQuestions", () => {
  it("exposes a schema-only ask_questions tool (no execute → loop pauses)", () => {
    const { tools } = createQuestions();
    // No `execute`: the harness pauses on the call and the renderer resolves it
    // by posting the user's answers back as the tool output.
    expect(tools.ask_questions.execute).toBeUndefined();
    expect(tools.ask_questions.inputSchema).toBe(questionnaireSchema);
  });
});
