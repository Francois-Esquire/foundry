import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { ObserveTurn } from "../../agents/model";
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
  /** What the event settled with — once, as `TurnObservation.emit` is
   *  idempotent — and whether the host's own telemetry had already seen the
   *  operation end, as evlog must before the event is emitted. */
  readonly settled: { afterEnd: boolean; error: unknown }[];
}

/** An `ObserveTurn` that records each observation it opens, with the model
 *  it wrapped, so a test can tell which turn ran under which observation. */
function recordingObserver(): { observe: ObserveTurn; opened: Opened[] } {
  const opened: Opened[] = [];
  const observe: ObserveTurn = ({ sessionId }) => {
    const settled: { afterEnd: boolean; error: unknown }[] = [];
    let ended = false;
    const emit = (error?: unknown) => {
      if (settled.length === 0) {
        settled.push({ afterEnd: ended, error });
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

/** A model stream that delivers a line of text — `smoothStream` releases
 *  text by the line — and then never finishes, so only its consumer can end
 *  the turn. */
function unfinishedStreamResult(): {
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

    expect(opened[0]?.settled).toEqual([{ afterEnd: false, error: undefined }]);
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

    // The cancel reaches the turn's stream through the SDK's pipes, a few
    // ticks after `cancel` resolves.
    await vi.waitFor(() =>
      expect(opened[0]?.settled).toEqual([
        { afterEnd: false, error: undefined },
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
    expect(opened[0]?.settled).toEqual([{ afterEnd: false, error: undefined }]);
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
