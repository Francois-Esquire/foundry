import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionRecord } from "../schema";
import type { SessionStore } from "../store";

/**
 * The behaviour every {@link SessionStore} shares. `open` returns a fresh,
 * empty store for each test. Registers Vitest tests; call it at module level
 * in a test file.
 *
 * Every write here changes one session, as every write `Sessions` builds
 * does, so a store that keeps each session apart can pass it.
 */
export function describeSessionStore(
  name: string,
  open: () => SessionStore | Promise<SessionStore>
): void {
  describe(`${name} (SessionStore)`, () => {
    it("reads nothing from an empty store", async () => {
      const store = await open();

      await expect(store.getSession("s")).resolves.toBeNull();
      await expect(store.getMessage("m")).resolves.toBeNull();
      await expect(store.listMessages("s")).resolves.toEqual([]);
    });

    it("files a session and reads it back as written", async () => {
      const store = await open();
      const linked = session("child", {
        parentMessageId: "pm",
        parentSessionId: "parent",
        recursionDepth: 2,
        title: "Child",
      });
      await store.commit({ putSessions: [linked] });

      await expect(store.getSession("child")).resolves.toStrictEqual(linked);
    });

    it("replaces a session put again under its id, keeping its messages", async () => {
      const store = await open();
      await store.commit({
        putMessages: [message("m1", "s", 1)],
        putSessions: [session("s")],
      });
      const renamed = session("s", { status: "archived", title: "t" });
      await store.commit({ putSessions: [renamed] });

      await expect(store.getSession("s")).resolves.toMatchObject({
        status: "archived",
        title: "t",
      });
      await expect(ids(store, "s")).resolves.toEqual(["m1"]);
    });

    it("lists a session's messages in the order they were filed", async () => {
      const store = await open();
      await store.commit({
        putMessages: [message("m2", "s", 2), message("m1", "s", 1)],
        putSessions: [session("s")],
      });
      await store.commit({ putMessages: [message("m3", "s", 3)] });

      await expect(ids(store, "s")).resolves.toEqual(["m2", "m1", "m3"]);
    });

    it("replaces a message put again under its id in place", async () => {
      const store = await open();
      await store.commit({
        putMessages: [message("m1", "s", 1), message("m2", "s", 2)],
        putSessions: [session("s")],
      });
      const folded = { ...message("m1", "s", 1), summarized: true };
      await store.commit({
        putMessages: [folded, message("m3", "s", 3)],
      });

      await expect(ids(store, "s")).resolves.toEqual(["m1", "m2", "m3"]);
      await expect(store.getMessage("m1")).resolves.toStrictEqual(folded);
    });

    it("reads a message by id from any session", async () => {
      const store = await open();
      const kept = message("b1", "b", 1, {
        metadata: { model: { id: "model", provider: "p" } },
        status: "streaming",
      });
      await store.commit({ putSessions: [session("a")] });
      await store.commit({ putMessages: [kept], putSessions: [session("b")] });

      await expect(store.getMessage("b1")).resolves.toStrictEqual(kept);
    });

    it("keeps each session's messages apart", async () => {
      const store = await open();
      await store.commit({
        putMessages: [message("a1", "a", 1)],
        putSessions: [session("a")],
      });
      await store.commit({
        putMessages: [message("b1", "b", 1)],
        putSessions: [session("b")],
      });

      await expect(ids(store, "a")).resolves.toEqual(["a1"]);
      await expect(ids(store, "b")).resolves.toEqual(["b1"]);
    });

    it("applies a write that cannot be stored not at all", async () => {
      const store = await open();
      await store.commit({
        putMessages: [message("m1", "s", 1)],
        putSessions: [session("s")],
      });
      const unstorable = message("m3", "s", 3, {
        parts: [
          {
            output: { big: 1n, run: () => undefined },
            toolCallId: "c",
            type: "tool_result",
          },
        ],
      });

      await expect(
        store.commit({
          putMessages: [
            { ...message("m1", "s", 1), summarized: true },
            message("m2", "s", 2),
            unstorable,
          ],
          putSessions: [{ ...session("s"), title: "changed" }],
        })
      ).rejects.toThrow();

      await expect(store.getSession("s")).resolves.toStrictEqual(session("s"));
      await expect(store.listMessages("s")).resolves.toStrictEqual([
        message("m1", "s", 1),
      ]);
      await expect(store.getMessage("m2")).resolves.toBeNull();
    });

    it("keeps what it holds apart from what it was given", async () => {
      const store = await open();
      const record = session("s");
      const written = message("m1", "s", 1);
      await store.commit({ putMessages: [written], putSessions: [record] });
      record.title = "mutated";
      written.parts.push({ text: "mutated", type: "text" });

      await expect(store.getSession("s")).resolves.toStrictEqual(session("s"));
      await expect(store.getMessage("m1")).resolves.toStrictEqual(
        message("m1", "s", 1)
      );
    });

    it("hands out values that do not change what it holds", async () => {
      const store = await open();
      await store.commit({
        putMessages: [message("m1", "s", 1)],
        putSessions: [session("s")],
      });

      const read = await store.getSession("s");
      if (read) {
        read.title = "mutated";
      }
      const [listed] = await store.listMessages("s");
      listed?.parts.push({ text: "mutated", type: "text" });
      const got = await store.getMessage("m1");
      if (got) {
        got.status = "error";
      }

      await expect(store.getSession("s")).resolves.toStrictEqual(session("s"));
      await expect(store.listMessages("s")).resolves.toStrictEqual([
        message("m1", "s", 1),
      ]);
    });
  });
}

function session(
  id: string,
  fields: Partial<SessionRecord> = {}
): SessionRecord {
  return {
    createdAt: 1,
    id,
    parentMessageId: null,
    parentSessionId: null,
    status: "active",
    title: null,
    updatedAt: 1,
    ...fields,
  };
}

function message(
  id: string,
  sessionId: string,
  at: number,
  fields: Partial<SessionMessage> = {}
): SessionMessage {
  return {
    createdAt: at,
    id,
    parts: [{ text: id, type: "text" }],
    role: "user",
    sessionId,
    status: "complete",
    updatedAt: at,
    ...fields,
  };
}

async function ids(store: SessionStore, sessionId: string): Promise<string[]> {
  return (await store.listMessages(sessionId)).map((m) => m.id);
}
