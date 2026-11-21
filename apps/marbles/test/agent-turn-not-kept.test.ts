import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { SessionHarness } from "@foundry/agents/harness";
import type { SessionEvent, SessionMessage } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";
import { InMemorySessionStore } from "@foundry/agents/store/memory";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import {
  replayedStream,
  replyOf,
  wrapAgentSession,
} from "../src/lib/managers/agent-turns";

import { StepWork } from "../src/lib/step-work";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 },
  outputTokens: { reasoning: 0, text: 0, total: 0 },
};

function model() {
  return new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { id: "answer", type: "text-start" },
            { delta: "hi", id: "answer", type: "text-delta" },
            { id: "answer", type: "text-end" },
            {
              finishReason: { raw: undefined, unified: "stop" },
              type: "finish",
              usage,
            },
          ],
        }),
      }),
  });
}

function refusingStore(): SessionStore {
  const inner = new InMemorySessionStore();
  const refusing = (store: SessionStore): SessionStore => ({
    commit: (write) =>
      write.putMessages?.some((message) => message.role === "assistant")
        ? Promise.reject(new Error("disk full"))
        : store.commit(write),
    getMessage: (id) => store.getMessage(id),
    getSession: (id) => store.getSession(id),
    listMessages: (sessionId) => store.listMessages(sessionId),
    transaction: (work) => inner.transaction((view) => work(refusing(view))),
  });
  return refusing(inner);
}

async function collect(stream: AsyncIterable<SessionEvent>) {
  const events: SessionEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

const { signal } = new AbortController();

describe("a Marbles agent turn whose reply the session could not keep", () => {
  it("ends in an error, with no finish, an error reply and a failed outcome", async () => {
    const harness = new SessionHarness(
      { instructions: "x", model: model(), store: refusingStore() },
      { sessionId: "s" }
    );
    const consumed = vi.fn();
    const session = wrapAgentSession(
      harness,
      { id: "s" },
      {
        consumed,
        signal: () => signal,
        takeResume: () => undefined,
        track: () => undefined,
        write: () => undefined,
      }
    );

    const turn = session.stream("go");
    const events = await collect(turn);
    const message = await turn.message;

    expect(events.map((event) => event.type)).toEqual(["text-delta", "error"]);
    expect(events.at(-1)).toMatchObject({
      error: {
        message: "The session could not keep the turn's reply: disk full",
      },
    });
    expect(message.status).toBe("error");
    await expect(turn.outcome).resolves.toBe("failed");
    expect(consumed).toHaveBeenCalledWith(message, expect.anything());
  });
});

describe("a replayed turn", () => {
  const reply = (fields: Partial<SessionMessage>): SessionMessage => ({
    createdAt: 1,
    id: "m",
    parts: [{ text: "hi", type: "text" }],
    role: "assistant",
    sessionId: "s",
    status: "complete",
    updatedAt: 1,
    ...fields,
  });

  it("finishes when its recorded reply completed", async () => {
    const events = await collect(replayedStream(replyOf(reply({}))));

    expect(events.map((event) => event.type)).toEqual(["finish"]);
  });

  it("ends in an error, with no finish, when its recorded reply failed", async () => {
    const events = await collect(
      replayedStream(
        replyOf(
          reply({
            parts: [
              { text: "hi", type: "text" },
              { message: "stream boom", type: "error" },
            ],
            status: "error",
          })
        )
      )
    );

    expect(events).toEqual([
      { error: new Error("stream boom"), type: "error" },
    ]);
  });
});

it("refuses steering while a finished turn records its usage", async () => {
  const harness = new SessionHarness(
    { instructions: "x", model: model(), store: new InMemorySessionStore() },
    { sessionId: "s" }
  );
  const work = new StepWork("review");
  const entered = Promise.withResolvers<void>();
  const recorded = Promise.withResolvers<void>();
  const session = wrapAgentSession(
    harness,
    { id: "s" },
    {
      consumed: async () => {
        entered.resolve();
        await recorded.promise;
      },
      signal: () => signal,
      takeResume: () => undefined,
      track: () => undefined,
      work,
      write: () => undefined,
    }
  );
  const turn = session.stream("go");
  const [target] = work.list();
  expect(target).toBeDefined();
  try {
    await entered.promise;
    expect(() =>
      work.send({ target: target?.id ?? "", text: "too late" })
    ).toThrow("no longer live");
    expect(work.list()).toEqual([]);
  } finally {
    recorded.resolve();
    await turn.message;
  }
});
