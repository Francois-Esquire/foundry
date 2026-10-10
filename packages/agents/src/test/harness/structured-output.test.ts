import { NoObjectGeneratedError, Output, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createInMemoryAgentAuthorizer } from "../../authorization/authorization";
import { createDriverSession } from "../../harness/driver-session";
import { SessionHarness } from "../../harness/session-harness";
import type { StreamPart } from "../../harness/stream-transform";
import { transformStream } from "../../harness/stream-transform";
import type { HarnessTurnDriver } from "../../harness/turn-driver";
import { InMemorySessionStore } from "../../session/store";
import type { StreamResult } from "../helpers/mock-language-model";
import { routed } from "../helpers/mock-language-model";
import { finish, textDelta, toolCall, usage } from "../helpers/stream-parts";

const person = Output.object({
  schema: z.object({ age: z.number(), name: z.string() }),
});

/** A stream that answers in several text deltas. */
function deltas(...texts: string[]): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { id: "t", type: "text-start" },
        ...texts.map((delta) => ({
          delta,
          id: "t",
          type: "text-delta" as const,
        })),
        { id: "t", type: "text-end" },
        {
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 },
            outputTokens: { reasoning: 0, text: 0, total: 0 },
          },
        },
      ],
    }),
  };
}

function harnessAnswering(...texts: string[]) {
  const calls: Parameters<MockLanguageModelV4["doStream"]>[0][] = [];
  const model = new MockLanguageModelV4({
    doStream: (options) => {
      calls.push(options);
      return Promise.resolve(deltas(...texts));
    },
  });
  const store = new InMemorySessionStore();
  const harness = new SessionHarness(
    {
      instructions: "x",
      model: routed(model, { id: "m", provider: "test" }),
      store,
      tools: {},
    },
    { sessionId: "s" }
  );
  return { calls, harness, store };
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) {
    out.push(item);
  }
  return out;
}

describe("structured output", () => {
  it("passes a turn's output and model settings to the model", async () => {
    // Guards the AI SDK's call spread: if an upgrade stops passing per-call
    // keys through `prepareCall`, this fails rather than silently dropping them.
    const { calls, harness } = harnessAnswering('{"age":3,"name":"Ada"}');
    await harness.generate("who?", { output: person, temperature: 0.2 });
    expect(calls[0]?.temperature).toBe(0.2);
    expect(calls[0]?.responseFormat).toMatchObject({ type: "json" });
  });

  it("resolves the value, streams partials, and stores it on the message", async () => {
    const { harness, store } = harnessAnswering(
      '{"name":"A',
      'da","age"',
      ":3}"
    );
    const turn = harness.stream("who?", { output: person });
    const partials = await collect(turn.partialOutputStream);
    expect(await turn.output).toEqual({ age: 3, name: "Ada" });
    expect(partials.at(0)).toEqual({ name: "A" });
    expect(partials.at(-1)).toEqual({ age: 3, name: "Ada" });
    const message = await turn.message;
    expect(message.metadata?.output).toEqual({ age: 3, name: "Ada" });
    const [, stored] = await store.listMessages("s");
    expect(stored?.metadata?.output).toEqual({ age: 3, name: "Ada" });
    expect(await turn.result).toBeDefined();
  });

  it("rejects an invalid value after committing the message", async () => {
    const { harness, store } = harnessAnswering('{"name":"Ada"}');
    const turn = harness.stream("who?", { output: person });
    await expect(turn.output).rejects.toSatisfy(
      NoObjectGeneratedError.isInstance
    );
    expect((await turn.message).status).toBe("complete");
    expect(await store.listMessages("s")).toHaveLength(2);
  });

  it("resolves a plain turn without a value or partials", async () => {
    const { calls, harness } = harnessAnswering("hello");
    const onFinish = vi.fn();
    const turn = harness.stream("hi", { onFinish });
    expect(await turn.output).toBeUndefined();
    expect(await collect(turn.partialOutputStream)).toEqual([]);
    await turn.message;
    expect(calls[0]?.responseFormat).toBeUndefined();
    // Stream handlers are the session's, never the SDK's own callbacks.
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]?.[0]).toHaveProperty("message");
  });

  it("parses only the final step's text", async () => {
    async function* steps(): AsyncGenerator<StreamPart> {
      yield textDelta("Let me look that up.");
      yield toolCall("c1", "lookup", {});
      yield { request: {}, type: "start-step", warnings: [] };
      yield textDelta('{"age":3,"name":"Ada"}', "text-2");
      yield finish(usage({}));
      await Promise.resolve();
    }
    const turn = transformStream(steps(), { output: person });
    expect(await turn.output).toEqual({ age: 3, name: "Ada" });
  });

  it("asks a CLI driver for JSON and parses its final text", async () => {
    const driver: HarnessTurnDriver = {
      capabilities: { interruption: true, steering: false },
      id: "native",
      run: vi.fn(() =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            yield textDelta('{"age":3,"name":"Ada"}');
          },
        })
      ),
    };
    const session = createDriverSession(
      {
        agentId: "coder",
        model: { harness: "native", id: "model" },
        policy: createInMemoryAgentAuthorizer().authorizer,
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 30,
          mode: "scheduled",
          unresolved: "deny",
        },
        sessionId: "d",
        store: new InMemorySessionStore(),
      },
      driver
    );
    const turn = session.stream("who?", { output: person });
    expect(await turn.output).toEqual({ age: 3, name: "Ada" });
    expect(await turn.result).toBeUndefined();
    expect(driver.run).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: expect.objectContaining({ type: "json" }),
      })
    );
  });
});
