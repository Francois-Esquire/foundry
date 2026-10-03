import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createInMemoryAgentAuthorizer } from "../../authorization";
import type {
  DriverSessionSettings,
  HarnessQuestion,
  HarnessQuestionCallback,
  HarnessQuestionResult,
  HarnessTurnDriver,
} from "../../harness";
import {
  createBuiltinCodingHarness,
  createDriverSession,
  createHarnessQuestionTool,
} from "../../harness";
import { InMemorySessionStore } from "../../session";
import {
  createScriptedMockModel,
  textStreamResult,
  toolCallStreamResult,
} from "../helpers/mock-language-model";

const questions: [HarnessQuestion] = [
  {
    id: "target",
    options: [{ label: "private-option" }],
    question: "Which token should I use?",
  },
];

function settings(): DriverSessionSettings {
  return {
    agentId: "coder",
    model: { harness: "native", id: "model" },
    policy: createInMemoryAgentAuthorizer().authorizer,
    profile: {
      allowedTools: [],
      disallowedTools: [],
      maxSteps: 8,
      mode: "attended",
      unresolved: "ask",
    },
    sessionId: "host-session",
    store: new InMemorySessionStore(),
  };
}

function questioningDriver(): HarnessTurnDriver {
  return {
    capabilities: { interruption: true, steering: false },
    id: "native",
    run: async (options) => {
      const result = await options.question({
        questions,
        sessionId: "untrusted",
        signal: new AbortController().signal,
        toolCallId: "question-1",
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            delta: result.outcome === "answered" ? "continued" : "declined",
            type: "text-delta",
          };
        },
      };
    },
  };
}

describe("harness questions", () => {
  it("continues the native turn with real answers and persists only outcome/counts", async () => {
    const config = settings();
    config.question = vi.fn(
      async (): Promise<HarnessQuestionResult> => ({
        answers: { target: ["private-answer"] },
        outcome: "answered",
      })
    );
    const session = createDriverSession(config, questioningDriver());
    const result = await session.generate("choose");
    expect(result.parts).toContainEqual({ text: "continued", type: "text" });
    expect(config.question).toHaveBeenCalledWith(
      expect.objectContaining({ questions, sessionId: "host-session" })
    );
    const history = await config.store.listMessages("host-session");
    expect(history.flatMap((message) => message.parts)).toContainEqual({
      answerCount: 1,
      harness: "native",
      outcome: "answered",
      questionCount: 1,
      toolCallId: "question-1",
      type: "harness_question",
    });
    expect(JSON.stringify(history)).not.toContain("private-answer");
    expect(JSON.stringify(history)).not.toContain("private-option");
    expect(JSON.stringify(history)).not.toContain(questions[0].question);
  });

  it("does not persist sensitive host callback exception text", async () => {
    const config = settings();
    config.question = async () => {
      throw new Error("private-answer private-token");
    };
    const result = await createDriverSession(
      config,
      questioningDriver()
    ).generate("choose");
    expect(result.status).toBe("error");
    expect(result.parts).toContainEqual({
      message: "Host question handler failed.",
      type: "error",
    });
    const history = JSON.stringify(
      await config.store.listMessages("host-session")
    );
    expect(history).not.toContain("private-answer");
    expect(history).not.toContain("private-token");
  });

  it("explicitly declines when the host has no question handler", async () => {
    const config = settings();
    const result = await createDriverSession(
      config,
      questioningDriver()
    ).generate("choose");
    expect(result.parts).toContainEqual({ text: "declined", type: "text" });
    expect(
      (await config.store.listMessages("host-session")).flatMap(
        (message) => message.parts
      )
    ).toContainEqual(
      expect.objectContaining({ outcome: "declined", type: "harness_question" })
    );
  });

  it("interrupts an unresponsive host, records interruption, and permits the next turn", async () => {
    const config = settings();
    config.question = vi.fn(() => new Promise<never>(() => undefined));
    const session = createDriverSession(config, questioningDriver());
    const pending = session.generate("choose");
    await vi.waitFor(() => expect(config.question).toHaveBeenCalledOnce());
    await session.interrupt();
    expect((await pending).status).toBe("error");
    expect(
      (await config.store.listMessages("host-session")).flatMap(
        (message) => message.parts
      )
    ).toContainEqual(
      expect.objectContaining({
        outcome: "interrupted",
        type: "harness_question",
      })
    );
    config.question = async () => ({
      outcome: "declined",
      reason: "No choice yet.",
    });
    expect((await session.generate("retry")).status).toBe("complete");
  });

  const invalidAnswers: HarnessQuestionResult[] = [
    { answers: {}, outcome: "answered" },
    { answers: { target: [] }, outcome: "answered" },
    { answers: { target: ["one", "two"] }, outcome: "answered" },
    { answers: { target: ["one"], unknown: ["two"] }, outcome: "answered" },
  ];

  it.each(invalidAnswers)(
    "never treats an incomplete or fabricated host response as answered: %j",
    async (response) => {
      const config = settings();
      config.question = async () => response;
      const result = await createDriverSession(
        config,
        questioningDriver()
      ).generate("choose");
      expect(result.status).toBe("error");
      expect(
        (await config.store.listMessages("host-session")).flatMap(
          (message) => message.parts
        )
      ).not.toContainEqual(
        expect.objectContaining({
          outcome: "answered",
          type: "harness_question",
        })
      );
    }
  );

  it("returns an explicit missing-handler decline to the built-in model and continues", async () => {
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("ask", "ask_user", { questions }),
        textStreamResult("I need a user answer before proceeding."),
      ],
    });
    const harness = createBuiltinCodingHarness(
      {
        agentId: "coder",
        compaction: { summarizer: { summarize: async () => "summary" } },
        maxSteps: 8,
        model,
        policy: createInMemoryAgentAuthorizer({ policy: { global: "deny" } })
          .authorizer,
        tools: {
          ask_user: createHarnessQuestionTool({ sessionId: "builtin" }),
        },
      },
      { sessionId: "builtin" }
    );
    const result = await harness.generate("choose");
    expect(result.status).toBe("complete");
    expect(result.parts).toContainEqual({
      output: {
        outcome: "declined",
        reason: "No host question handler is configured.",
      },
      toolCallId: "ask",
      type: "tool_result",
    });
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("cancels a built-in question waiting for an unresponsive host", async () => {
    const question = vi.fn(() => new Promise<never>(() => undefined));
    const model = createScriptedMockModel({
      stream: [toolCallStreamResult("ask", "ask_user", { questions })],
    });
    const harness = createBuiltinCodingHarness(
      {
        agentId: "coder",
        compaction: { summarizer: { summarize: async () => "summary" } },
        maxSteps: 8,
        model,
        policy: createInMemoryAgentAuthorizer({ policy: { global: "deny" } })
          .authorizer,
        tools: {
          ask_user: createHarnessQuestionTool({
            question,
            sessionId: "builtin",
          }),
        },
      },
      { sessionId: "builtin" }
    );
    const turn = harness.generate("choose");
    await vi.waitFor(() => expect(question).toHaveBeenCalledOnce());
    await harness.interrupt();
    expect((await turn).status).toBe("error");
    expect((await turn).parts).not.toContainEqual(
      expect.objectContaining({
        output: expect.objectContaining({ outcome: "answered" }),
        type: "tool_result",
      })
    );
  });

  it("allows the trusted communication tool while denying an ordinary tool with the same name", async () => {
    const question = vi.fn(async () => ({
      answers: { target: ["selected"] },
      outcome: "answered" as const,
    }));
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("ask", "ask_user", { questions }),
        textStreamResult("continued"),
      ],
    });
    const harness = createBuiltinCodingHarness(
      {
        agentId: "coder",
        compaction: { summarizer: { summarize: async () => "summary" } },
        maxSteps: 8,
        model,
        policy: createInMemoryAgentAuthorizer({ policy: { global: "deny" } })
          .authorizer,
        tools: {
          ask_user: createHarnessQuestionTool({
            question,
            sessionId: "builtin",
          }),
        },
      },
      { sessionId: "builtin" }
    );
    const result = await harness.generate("choose");
    expect(question).toHaveBeenCalledOnce();
    expect(result.parts).toContainEqual({
      output: { answers: { target: ["selected"] }, outcome: "answered" },
      toolCallId: "ask",
      type: "tool_result",
    });
    expect(result.parts).toContainEqual({ text: "continued", type: "text" });
    const execute = vi.fn(async () => "should not execute");
    const ordinary = createBuiltinCodingHarness(
      {
        agentId: "coder",
        compaction: { summarizer: { summarize: async () => "summary" } },
        maxSteps: 8,
        model: createScriptedMockModel({
          stream: [
            toolCallStreamResult("fake", "ask_user", {}),
            textStreamResult("denied"),
          ],
        }),
        policy: createInMemoryAgentAuthorizer({ policy: { global: "deny" } })
          .authorizer,
        tools: { ask_user: tool({ execute, inputSchema: z.object({}) }) },
      },
      { sessionId: "ordinary" }
    );
    await ordinary.generate("choose");
    expect(execute).not.toHaveBeenCalled();
  });
});

it.each(["native-child", 42, undefined])(
  "forwards only native string activity context through the shared question tool (%s)",
  async (activityId) => {
    const question = vi.fn<HarnessQuestionCallback>(async () => ({
      outcome: "declined" as const,
      reason: "No answer",
    }));
    const shared = createHarnessQuestionTool({
      question,
      sessionId: "session",
    });
    if (!shared.execute) {
      throw new Error("Missing question executor");
    }
    await shared.execute(
      { questions },
      { context: { activityId }, messages: [], toolCallId: "ask" }
    );
    expect(question).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session", toolCallId: "ask" })
    );
    const request = question.mock.calls[0]?.[0];
    expect(request?.activityId).toBe(
      typeof activityId === "string" ? activityId : undefined
    );
  }
);
