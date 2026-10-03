import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonSessionStore } from "~/sessions/json-store";

const writes = vi.hoisted(() => ({
  fail: false,
  pause: undefined as Promise<void> | undefined,
  started: 0,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      writes.started += 1;
      const { pause } = writes;
      if (pause) {
        writes.pause = undefined;
        await pause;
      }
      if (writes.fail) {
        writes.fail = false;
        throw new Error("injected write failure");
      }
      return actual.writeFile(...args);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  writes.pause = undefined;
  writes.fail = false;
  for (const path of directories.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

describe("session disk write ordering", () => {
  it("serializes same-session snapshots so slow earlier writes cannot erase durable events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quirks-session-order-"));
    directories.push(directory);
    const store = new JsonSessionStore(directory);
    await store.createSession({ id: "session" });
    writes.started = 0;
    let release!: () => void;
    writes.pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.appendMessage({
      parts: [{ text: "tool attempted", type: "text" }],
      role: "system",
      sessionId: "session",
    });
    const second = store.appendMessage({
      parts: [{ text: "approval required", type: "text" }],
      role: "system",
      sessionId: "session",
    });
    await vi.waitFor(() => expect(writes.started).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes.started).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(new JsonSessionStore(directory).sessions()).toHaveLength(1);
    const persisted = JSON.parse(
      await readFile(join(directory, "session.json"), "utf8")
    );
    expect(
      persisted.messages.map(
        (message: { parts: { text: string }[] }) => message.parts[0]?.text
      )
    ).toEqual(["tool attempted", "approval required"]);
  });

  it("continues persistence after an earlier write failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quirks-session-order-"));
    directories.push(directory);
    const store = new JsonSessionStore(directory);
    await store.createSession({ id: "session" });
    writes.fail = true;
    await expect(
      store.appendMessage({
        parts: [{ text: "first", type: "text" }],
        role: "system",
        sessionId: "session",
      })
    ).rejects.toThrow("injected write failure");
    await store.appendMessage({
      parts: [{ text: "second", type: "text" }],
      role: "system",
      sessionId: "session",
    });
    expect(
      await new JsonSessionStore(directory).listMessages("session")
    ).toHaveLength(2);
  });
});
