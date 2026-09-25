import { describe, expect, it } from "vitest";

import { createLog } from "~/lib/log";
import type { Socket } from "~/live";
import { attachSocket, readMessage } from "~/live";
import type { Change, WsMonitor } from "~/monitor";
import { detector } from "~/monitor";

import { monitorContext } from "./helpers/monitor";

describe("ws pipeline", () => {
  type Listener = (event: { readonly data?: unknown }) => void;

  function fakeSocket() {
    const listeners = new Map<string, Listener>();
    const sent: string[] = [];
    const socket: Socket = {
      addEventListener: (type, listener) => listeners.set(type, listener),
      close: () => undefined,
      send: (data) => sent.push(data),
    };
    const emit = (type: string, data?: unknown) =>
      listeners.get(type)?.({ data });
    return { emit, sent, socket };
  }

  it("parses JSON when it parses, keeps text otherwise, then selects", () => {
    expect(readMessage({ url: "ws://x" }, '{"a":1}')).toEqual({ a: 1 });
    expect(readMessage({ url: "ws://x" }, "plain")).toBe("plain");
    expect(readMessage({ url: "ws://x" }, Buffer.from("[1]"))).toEqual([1]);
    const spec: WsMonitor = {
      select: (message) =>
        typeof message === "object" && message !== null && "a" in message
          ? message.a
          : message,
      url: "ws://x",
    };
    expect(readMessage(spec, '{"a":"picked"}')).toBe("picked");
  });

  it("sends on open, hands each selected message on, reports close", () => {
    const { socket, sent, emit } = fakeSocket();
    const messages: unknown[] = [];
    let closed = 0;
    attachSocket(
      socket,
      { send: '{"subscribe":"ticks"}', url: "ws://x" },
      {
        close: () => {
          closed += 1;
        },
        message: (message) => {
          messages.push(message);
        },
      }
    );
    expect(sent).toEqual([]);
    emit("open");
    expect(sent).toEqual(['{"subscribe":"ticks"}']);
    emit("message", '{"n":1}');
    emit("message", "hello");
    expect(messages).toEqual([{ n: 1 }, "hello"]);
    emit("close");
    expect(closed).toBe(1);
  });
});

describe("ws detector", () => {
  const lines: string[] = [];
  const log = createLog((_level, message) => lines.push(message));
  const changes: Change[] = [];
  const messages: unknown[] = [];
  const detect = detector("feed", { kind: "ws", url: "ws://x" }, (context) => {
    changes.push(context.change);
    messages.push(context.message);
    return "ok";
  });

  it("is live-only under a poll and handles a message as a change", async () => {
    await expect(detect(monitorContext(log))).resolves.toEqual({
      changed: false,
    });
    expect(lines).toEqual(["[monitor] feed is live-only; run `quirks run`"]);
    expect(changes).toEqual([]);

    await expect(
      detect(monitorContext(log, { message: { n: 1 } }))
    ).resolves.toEqual({ changed: true, handled: "ok" });
    expect(changes).toEqual([{ kind: "ws", message: { n: 1 } }]);
    expect(messages).toEqual([{ n: 1 }]);
  });
});
