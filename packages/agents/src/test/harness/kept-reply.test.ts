import { describe, expect, it, vi } from "vitest";

import { SessionHarness } from "../../harness/session-harness";
import type { StreamPart } from "../../harness/stream-transform";
import { transformStream } from "../../harness/stream-transform";
import type { SessionEvent } from "../../session/events";
import { Sessions } from "../../session/sessions";
import { MemorySessionStore } from "../../store/memory";
import { SqliteSessionStore } from "../../store/sqlite";
import {
  createScriptedMockModel,
  textStreamResult,
} from "../helpers/mock-language-model";
import { recordingStore } from "../helpers/recording-store";
import { libsqlDatabases } from "../helpers/sqlite";
import { finish, textDelta, toolCall, usage } from "../helpers/stream-parts";

const memory = libsqlDatabases("memory");

async function collect(stream: AsyncIterable<SessionEvent>) {
  const events: SessionEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function* source(parts: StreamPart[]): AsyncGenerator<StreamPart> {
  for (const part of parts) {
    yield part;
  }
  await Promise.resolve();
}

function negativeZeroTurn(): StreamPart[] {
  return [
    {
      ...toolCall("call-1", "probe", { at: [JSON.parse("-0")], n: -0 }),
      providerMetadata: { google: { thoughtSignature: "sig", weight: -0 } },
    },
    textDelta("done"),
    finish(usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })),
  ];
}

describe("a turn's reply over the SQLite store", () => {
  it("keeps a tool call whose input and provider metadata hold -0, as 0", async () => {
    const store = new SqliteSessionStore({
      database: await memory.open(),
      scope: "s",
    });
    const sessions = new Sessions({ store });
    await sessions.createSession({ id: "s" });
    const onError = vi.fn();
    const onFinish = vi.fn();

    const stream = transformStream(source(negativeZeroTurn()), {
      commit: (message) =>
        sessions.appendMessage({
          metadata: message.metadata,
          parts: message.parts,
          role: "assistant",
          sessionId: "s",
          status: message.status,
        }),
      handlers: { onError, onFinish },
      sessionId: "s",
    });
    await collect(stream);
    const reply = await stream.message;

    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(reply.status).toBe("complete");
    const [stored] = await store.listMessages("s");
    expect(stored).toStrictEqual(reply);
    expect(stored?.parts[0]).toStrictEqual({
      input: { at: [0], n: 0 },
      name: "probe",
      providerOptions: { google: { thoughtSignature: "sig", weight: 0 } },
      toolCallId: "call-1",
      type: "tool_call",
    });
    const input = (stored?.parts[0] as { input?: { n: number } } | undefined)
      ?.input;
    expect(Object.is(input?.n, 0)).toBe(true);
  });
});

describe("a reply the store refuses", () => {
  function refusingHarness() {
    const inner = new MemorySessionStore();
    const { store } = recordingStore(inner, (write) => {
      if (write.putMessages?.some((m) => m.role === "assistant")) {
        throw new Error("disk full");
      }
    });
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: createScriptedMockModel({ stream: [textStreamResult("hi")] }),
        store,
      },
      { sessionId: "s" }
    );
    return { harness, inner };
  }

  it("fails the turn: error status, onError, no finish, nothing reported complete", async () => {
    const { harness, inner } = refusingHarness();
    const onError = vi.fn();
    const onFinish = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      const turn = harness.stream("go", { onError, onFinish });
      const events = await collect(turn);
      const reply = await turn.message;

      const why = "The session could not keep the turn's reply: disk full";
      expect(reply.status).toBe("error");
      expect(reply.sessionId).toBe("s");
      expect(reply.parts.at(-1)).toEqual({ message: why, type: "error" });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: why })
      );
      expect(onFinish).not.toHaveBeenCalled();
      expect(events.map((event) => event.type)).not.toContain("finish");
      await expect(turn.outcome).resolves.toBe("failed");
      expect(
        (await inner.listMessages("s")).map((m) => [m.role, m.status])
      ).toEqual([["user", "complete"]]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("rejects generate's reply as an error message, not a stored one", async () => {
    const { harness } = refusingHarness();

    const reply = await harness.generate("go");

    expect(reply.status).toBe("error");
  });

  it("fails the turn when Sessions cannot keep the reply, naming the path", async () => {
    const sessions = new Sessions();
    await sessions.createSession({ id: "s" });
    const onError = vi.fn();
    const stream = transformStream(
      source([toolCall("call-1", "probe", { count: 1n }), finish(usage({}))]),
      {
        commit: (message) =>
          sessions.appendMessage({
            parts: message.parts,
            role: "assistant",
            sessionId: "s",
          }),
        handlers: { onError },
      }
    );
    await collect(stream);

    expect((await stream.message).status).toBe("error");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "parts[0].input.count has no JSON form"
        ),
      })
    );
    await expect(sessions.listMessages("s")).resolves.toEqual([]);
  });
});
