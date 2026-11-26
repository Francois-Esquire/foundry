import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { ObserveTurn } from "@foundry/core/agents";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { AgentHarness } from "../../harness/agent-harness";
import { SessionHarness } from "../../harness/session-harness";
import {
  createScriptedMockModel,
  textGenerateResult,
  textStreamResult,
} from "../helpers/mock-language-model";

interface Opened {
  readonly model: MockLanguageModelV4;
  readonly sessionId: string;
  readonly settled: {
    afterEnd: boolean;
    error: unknown;
    outcome?: "cancelled";
  }[];
}

function recordingObserver(): { observe: ObserveTurn; opened: Opened[] } {
  const opened: Opened[] = [];
  const observe: ObserveTurn = ({ sessionId }) => {
    const settled: {
      afterEnd: boolean;
      error: unknown;
      outcome?: "cancelled";
    }[] = [];
    let ended = false;
    const emit = (error?: unknown, outcome?: "cancelled") => {
      if (settled.length === 0) {
        settled.push({
          afterEnd: ended,
          error,
          ...(outcome ? { outcome } : {}),
        });
      }
    };
    const integration = {
      onEnd: () => {
        ended = true;
      },
    };
    const wrap = (model: LanguageModelV4) => {
      const wrapped = new MockLanguageModelV4({
        doGenerate: (options) => model.doGenerate(options),
        doStream: (options) => model.doStream(options),
      });
      opened.push({ model: wrapped, sessionId, settled });
      return wrapped;
    };
    return {
      emit,
      telemetry: { integrations: integration, isEnabled: true },
      wrap,
    };
  };
  return { observe, opened };
}

function unfinishedStreamResult(signal?: AbortSignal): {
  stream: ReadableStream<LanguageModelV4StreamPart>;
} {
  return {
    stream: new ReadableStream({
      start: (controller) => {
        controller.enqueue({ id: "text-1", type: "text-start" });
        controller.enqueue({
          delta: "partial\n",
          id: "text-1",
          type: "text-delta",
        });
        signal?.addEventListener("abort", () => controller.close(), {
          once: true,
        });
      },
    }),
  };
}

describe("LoopAgent — observation", () => {
  it("observes each streamed session turn under its own observation, settled once", async () => {
    const { observe, opened } = recordingObserver();
    const harness = new SessionHarness({
      instructions: "x",
      model: createScriptedMockModel({
        stream: [textStreamResult("one"), textStreamResult("two")],
      }),
      observe,
    });

    await harness.generate("first");
    await harness.generate("second");

    expect(opened).toHaveLength(2);
    for (const turn of opened) {
      expect(turn.sessionId).toBe(harness.sessionId);
      expect(turn.model.doStreamCalls).toHaveLength(1);
      expect(turn.settled).toEqual([{ afterEnd: true, error: undefined }]);
    }
  });

  it("observes each generated turn under its own observation, settled once", async () => {
    const { observe, opened } = recordingObserver();
    const harness = new AgentHarness({
      instructions: "x",
      model: createScriptedMockModel({
        generate: [textGenerateResult("one"), textGenerateResult("two")],
      }),
      observe,
    });

    await harness.generate({ prompt: "first" });
    await harness.generate({ prompt: "second" });

    expect(opened).toHaveLength(2);
    for (const turn of opened) {
      expect(turn.model.doGenerateCalls).toHaveLength(1);
      expect(turn.settled).toEqual([{ afterEnd: true, error: undefined }]);
    }
  });

  it("settles a streamed turn its consumer abandons partway", async () => {
    const { observe, opened } = recordingObserver();
    const harness = new AgentHarness({
      instructions: "x",
      model: createScriptedMockModel({ stream: [unfinishedStreamResult()] }),
      observe,
    });

    const { parts } = await harness.stream({ prompt: "go" });
    for await (const part of parts) {
      if (part.type === "text-delta") {
        break;
      }
    }

    expect(opened[0]?.settled).toEqual([
      { afterEnd: false, error: undefined, outcome: "cancelled" },
    ]);
  });

  it("records a signal-aborted turn as cancelled while its stream is being read", async () => {
    const { observe, opened } = recordingObserver();
    const controller = new AbortController();
    const harness = new AgentHarness({
      instructions: "x",
      model: new MockLanguageModelV4({
        doStream: async ({ abortSignal }) =>
          unfinishedStreamResult(abortSignal),
      }),
      observe,
    });
    const { parts } = await harness.stream({
      abortSignal: controller.signal,
      prompt: "go",
    });
    for await (const part of parts) {
      if (part.type === "text-delta") {
        controller.abort();
      }
    }
    expect(opened[0]?.settled).toEqual([
      { afterEnd: false, error: undefined, outcome: "cancelled" },
    ]);
  });

  it("settles a turn whose UI message stream is cancelled, as by a client disconnecting", async () => {
    const { observe, opened } = recordingObserver();
    const harness = new AgentHarness({
      instructions: "x",
      model: createScriptedMockModel({ stream: [unfinishedStreamResult()] }),
      observe,
    });

    const result = await harness.agent.stream({ prompt: "go" });
    const reader = result.toUIMessageStream().getReader();
    let chunk = await reader.read();
    while (!chunk.done && chunk.value.type !== "text-delta") {
      chunk = await reader.read();
    }
    await reader.cancel();

    await vi.waitFor(() =>
      expect(opened[0]?.settled).toEqual([
        { afterEnd: false, error: undefined, outcome: "cancelled" },
      ])
    );
  });

  it("settles a session turn whose stream handler throws", async () => {
    const { observe, opened } = recordingObserver();
    const harness = new SessionHarness({
      instructions: "x",
      model: createScriptedMockModel({ stream: [unfinishedStreamResult()] }),
      observe,
    });

    const reply = await harness.generate("go", {
      onText: () => {
        throw new Error("handler failed");
      },
    });

    expect(reply.status).toBe("error");
    expect(opened[0]?.settled).toEqual([
      { afterEnd: false, error: undefined, outcome: "cancelled" },
    ]);
  });

  it("settles a turn whose model fails with the error", async () => {
    const { observe, opened } = recordingObserver();
    const failure = new Error("model down");
    const model = createScriptedMockModel({});
    model.doGenerate = () => Promise.reject(failure);
    const harness = new AgentHarness({ instructions: "x", model, observe });

    await expect(harness.generate({ prompt: "go" })).rejects.toThrow(
      "model down"
    );

    expect(opened).toHaveLength(1);
    expect(opened[0]?.settled).toEqual([{ afterEnd: false, error: failure }]);
  });
});
