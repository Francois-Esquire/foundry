import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sessions } from "@foundry/agents/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonSessionStore } from "~/lib/sessions/json-store";

const writes = vi.hoisted(() => ({
  fail: false,
  failAt: undefined as number | undefined,
  pause: undefined as Promise<void> | undefined,
  reads: [] as string[],
  started: 0,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      writes.reads.push(String(args[0]));
      return actual.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      writes.started += 1;
      const { pause } = writes;
      if (pause) {
        writes.pause = undefined;
        await pause;
      }
      if (writes.fail || writes.started === writes.failAt) {
        writes.fail = false;
        writes.failAt = undefined;
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
  writes.failAt = undefined;
  writes.reads = [];
  for (const path of directories.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

describe("session disk write ordering", () => {
  it("serializes same-session snapshots so slow earlier writes cannot erase durable events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marbles-session-order-"));
    directories.push(directory);
    const store = new JsonSessionStore(directory);
    const sessions = new Sessions({ store });
    await sessions.createSession({ id: "session" });
    writes.started = 0;
    let release!: () => void;
    writes.pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = sessions.appendMessage({
      parts: [{ text: "tool attempted", type: "text" }],
      role: "system",
      sessionId: "session",
    });
    const second = sessions.appendMessage({
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

  // The file is the truth: a message whose write failed was never stored, and
  // the next append builds on what is on disk.
  it("continues persistence after an earlier write failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marbles-session-order-"));
    directories.push(directory);
    const store = new JsonSessionStore(directory);
    const sessions = new Sessions({ store });
    await sessions.createSession({ id: "session" });
    writes.fail = true;
    await expect(
      sessions.appendMessage({
        parts: [{ text: "first", type: "text" }],
        role: "system",
        sessionId: "session",
      })
    ).rejects.toThrow("injected write failure");
    await sessions.appendMessage({
      parts: [{ text: "second", type: "text" }],
      role: "system",
      sessionId: "session",
    });
    const messages = await new JsonSessionStore(directory).listMessages(
      "session"
    );
    expect(messages.map((message) => message.parts[0])).toEqual([
      { text: "second", type: "text" },
    ]);
    await expect(store.listMessages("session")).resolves.toHaveLength(1);
  });

  it("puts back a moved message when the second file's write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marbles-session-order-"));
    directories.push(directory);
    const store = new JsonSessionStore(directory);
    const sessions = new Sessions({ store });
    await sessions.createSession({ id: "a" });
    await sessions.createSession({ id: "b" });
    const message = await sessions.appendMessage({
      parts: [{ text: "moving", type: "text" }],
      role: "user",
      sessionId: "a",
    });

    writes.failAt = writes.started + 2;
    await expect(
      store.commit({ putMessages: [{ ...message, sessionId: "b" }] })
    ).rejects.toThrow("injected write failure");

    const reader = new JsonSessionStore(directory);
    await expect(reader.getMessage(message.id)).resolves.toEqual(message);
    await expect(reader.listMessages("a")).resolves.toEqual([message]);
    await expect(reader.listMessages("b")).resolves.toEqual([]);
  });

  it("reads again only the files that changed to place a new message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marbles-session-order-"));
    directories.push(directory);
    const seeding = new Sessions({ store: new JsonSessionStore(directory) });
    for (const id of ["a", "b", "c"]) {
      await seeding.createSession({ id });
      await seeding.appendMessage({
        parts: [{ text: id, type: "text" }],
        role: "user",
        sessionId: id,
      });
    }
    const sessions = new Sessions({ store: new JsonSessionStore(directory) });
    const append = () =>
      sessions.appendMessage({
        parts: [{ text: "next", type: "text" }],
        role: "user",
        sessionId: "a",
      });
    await append();

    writes.reads = [];
    await append();

    expect(writes.reads.some((path) => path.endsWith("a.json"))).toBe(true);
    expect(
      writes.reads.filter(
        (path) => path.endsWith("b.json") || path.endsWith("c.json")
      )
    ).toEqual([]);
  });

  it("refuses a new message, naming the file, while a session file cannot be read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marbles-session-order-"));
    directories.push(directory);
    const sessions = new Sessions({ store: new JsonSessionStore(directory) });
    await sessions.createSession({ id: "a" });
    await mkdir(join(directory, "b.json"));

    await expect(
      sessions.appendMessage({
        parts: [{ text: "new", type: "text" }],
        role: "user",
        sessionId: "a",
      })
    ).rejects.toThrow(join(directory, "b.json"));
    await expect(
      new JsonSessionStore(directory).listMessages("a")
    ).resolves.toEqual([]);
  });
});
