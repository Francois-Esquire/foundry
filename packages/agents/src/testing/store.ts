import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionRecord } from "../schema";
import type { SessionStore } from "../store";

/**
 * Fresh, empty storage: a store for each scope, all over the same storage.
 * Asking for one scope twice gives two stores over the same data.
 */
export type SessionStorage = (scope: string) => SessionStore;

/**
 * The behaviour every {@link SessionStore} shares. `open` returns fresh,
 * empty storage for each test. Registers Vitest tests; call it at module
 * level in a test file.
 *
 * Every write here changes one session, as every write `Sessions` builds
 * does, so a store that keeps each session apart can pass it.
 */
export function describeSessionStore(
  name: string,
  open: () => SessionStorage | Promise<SessionStorage>
): void {
  const fresh = async (): Promise<SessionStore> => (await open())("scope");

  describe(`${name} (SessionStore)`, () => {
    it("reads nothing from an empty store", async () => {
      const store = await fresh();

      await expect(store.getSession("s")).resolves.toBeNull();
      await expect(store.getMessage("m")).resolves.toBeNull();
      await expect(store.listMessages("s")).resolves.toEqual([]);
    });

    it("files a session and reads it back as written", async () => {
      const store = await fresh();
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
      const store = await fresh();
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
      const store = await fresh();
      await store.commit({
        putMessages: [message("m2", "s", 2), message("m1", "s", 1)],
        putSessions: [session("s")],
      });
      await store.commit({ putMessages: [message("m3", "s", 3)] });

      await expect(ids(store, "s")).resolves.toEqual(["m2", "m1", "m3"]);
    });

    it("replaces a message put again under its id in place", async () => {
      const store = await fresh();
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
      const store = await fresh();
      const kept = message("b1", "b", 1, {
        metadata: { model: { id: "model", provider: "p" } },
        status: "streaming",
      });
      await store.commit({ putSessions: [session("a")] });
      await store.commit({ putMessages: [kept], putSessions: [session("b")] });

      await expect(store.getMessage("b1")).resolves.toStrictEqual(kept);
    });

    it("keeps each session's messages apart", async () => {
      const store = await fresh();
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
      const store = await fresh();
      await store.commit({
        putMessages: [message("m1", "s", 1)],
        putSessions: [session("s")],
      });
      const unstorable = message("m3", "s", 3);
      Object.defineProperty(unstorable.parts[0], "text", {
        enumerable: true,
        get: () => {
          throw new Error("unstorable");
        },
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
      ).rejects.toThrow("unstorable");

      await expect(store.getSession("s")).resolves.toStrictEqual(session("s"));
      await expect(store.listMessages("s")).resolves.toStrictEqual([
        message("m1", "s", 1),
      ]);
      await expect(store.getMessage("m2")).resolves.toBeNull();
    });

    it("keeps what it holds apart from what it was given", async () => {
      const store = await fresh();
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
      const store = await fresh();
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

    it("keeps each scope apart", async () => {
      const storage = await open();
      const a = storage("a");
      const b = storage("b");
      await a.commit({
        putMessages: [message("m1", "s", 1)],
        putSessions: [session("s")],
      });

      await expect(b.getSession("s")).resolves.toBeNull();
      await expect(b.getMessage("m1")).resolves.toBeNull();
      await expect(b.listMessages("s")).resolves.toEqual([]);
      await b.commit({ putSessions: [session("s", { title: "b" })] });
      await expect(a.getSession("s")).resolves.toStrictEqual(session("s"));
      await expect(storage("a").getSession("s")).resolves.toStrictEqual(
        session("s")
      );
    });

    it("runs a transaction's reads and commit through its view", async (context) => {
      const store = await fresh();
      if (store.transaction === undefined) {
        context.skip();
        return;
      }
      await store.commit({ putSessions: [session("s")] });

      const result = await store.transaction(async (view) => {
        const current = await view.getSession("s");
        await view.commit({
          putMessages: [message("m1", "s", 1)],
          putSessions: [{ ...session("s"), title: current?.title ?? "none" }],
        });
        return (await view.listMessages("s")).length;
      });

      expect(result).toBe(1);
      await expect(store.getMessage("m1")).resolves.toStrictEqual(
        message("m1", "s", 1)
      );
      await expect(store.getSession("s")).resolves.toMatchObject({
        title: "none",
      });
    });

    it("lets no other transaction land between a transaction's reads and its commit", async (context) => {
      const storage = await open();
      const first = storage("a");
      const second = storage("a");
      if (first.transaction === undefined || second.transaction === undefined) {
        context.skip();
        return;
      }
      await first.commit({ putSessions: [session("s", { title: "0" })] });
      const read = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const writer = first.transaction(async (view) => {
        await view.getSession("s");
        read.resolve();
        await release.promise;
        await view.commit({ putSessions: [session("s", { title: "1" })] });
      });
      await read.promise;
      const follower = second.transaction(async (view) => {
        const seen = await view.getSession("s");
        await view.commit({
          putSessions: [session("s", { title: `${seen?.title}+` })],
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      release.resolve();
      await Promise.all([writer, follower]);

      await expect(second.getSession("s")).resolves.toMatchObject({
        title: "1+",
      });
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
