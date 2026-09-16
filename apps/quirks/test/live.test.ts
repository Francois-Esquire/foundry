import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Primitives } from "~/lib/registry";
import type { Socket } from "~/live";
import { attachSocket, readMessage, watchFiles } from "~/live";
import type { Change, WsMonitor } from "~/monitor";
import { detector } from "~/monitor";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (!done() && Date.now() - start < ms) {
    await sleep(50);
  }
  return done();
}

/** Sandboxes deny FSEvents; neither backend fires there, so the watcher cases skip. */
async function probeWatch(): Promise<string | undefined> {
  const root = mkdtempSync(join(tmpdir(), "quirks-live-probe-"));
  const seen: { fired: boolean; failure?: string } = { fired: false };
  const watching = watchFiles(
    root,
    () => (seen.fired = true),
    (error) => (seen.failure = String(error))
  );
  await watching.ready;
  writeFileSync(join(root, "probe.txt"), "x");
  await waitFor(() => seen.fired || seen.failure !== undefined, 2000);
  watching.stop();
  return seen.fired
    ? undefined
    : `no watcher backend here: ${seen.failure ?? "no event in 2s"}`;
}

const unavailable = await probeWatch();

describe.skipIf(unavailable !== undefined)(
  ["watchFiles", unavailable].filter(Boolean).join(" "),
  () => {
    it("fires on a write, then not after stop", async () => {
      const root = mkdtempSync(join(tmpdir(), "quirks-live-"));
      let calls = 0;
      const watching = watchFiles(
        root,
        () => (calls += 1),
        () => undefined
      );
      await watching.ready;

      writeFileSync(join(root, "a.md"), "one\n");
      expect(await waitFor(() => calls === 1, 2000)).toBe(true);

      watching.stop();
      writeFileSync(join(root, "b.md"), "two\n");
      await sleep(600);
      expect(calls).toBe(1);
    });

    it("coalesces a burst of writes into one call", async () => {
      const root = mkdtempSync(join(tmpdir(), "quirks-live-"));
      let calls = 0;
      const watching = watchFiles(
        root,
        () => (calls += 1),
        () => undefined
      );
      await watching.ready;

      writeFileSync(join(root, "a.md"), "1\n");
      writeFileSync(join(root, "b.md"), "2\n");
      writeFileSync(join(root, "c.md"), "3\n");
      expect(await waitFor(() => calls >= 1, 2000)).toBe(true);
      await sleep(400);
      expect(calls).toBe(1);
      watching.stop();
    });
  }
);

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
        close: () => (closed += 1),
        message: (message) => messages.push(message),
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
  const primitives: Primitives = {
    log: (line: string) => lines.push(line),
    workspace: { root: "/nowhere" },
  } as never;
  const changes: Change[] = [];
  const detect = detector(
    "feed",
    { kind: "ws", url: "ws://x" },
    (_, change) => {
      changes.push(change);
      return Promise.resolve("ok");
    }
  );

  it("is live-only under a poll and handles a message as a change", async () => {
    await expect(detect(primitives, null)).resolves.toEqual({ changed: false });
    expect(lines).toEqual(["[monitor] feed is live-only; run `quirks run`"]);
    expect(changes).toEqual([]);

    await expect(detect(primitives, { message: { n: 1 } })).resolves.toEqual({
      changed: true,
      handled: "ok",
    });
    expect(changes).toEqual([{ kind: "ws", message: { n: 1 } }]);
  });
});
