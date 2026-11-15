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

    it("moves a message put again under another session", async () => {
      const storage = await open();
      const store = storage("a");
      await store.commit({
        putMessages: [message("m1", "a", 1), message("m2", "a", 2)],
        putSessions: [session("a"), session("b")],
      });
      const moved = message("m1", "b", 1);
      await store.commit({ putMessages: [moved] });

      for (const reader of [store, storage("a")]) {
        await expect(ids(reader, "a")).resolves.toEqual(["m2"]);
        await expect(ids(reader, "b")).resolves.toEqual(["m1"]);
        await expect(reader.getMessage("m1")).resolves.toStrictEqual(moved);
      }
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

    it("applies a write across sessions as one, or not at all", async () => {
      const store = await fresh();
      await store.commit({
        putMessages: [message("a1", "a", 1), message("b1", "b", 1)],
        putSessions: [session("a"), session("b")],
      });
      await expect(ids(store, "a")).resolves.toEqual(["a1"]);
      await expect(ids(store, "b")).resolves.toEqual(["b1"]);

      const unstorable = message("b2", "b", 2);
      Object.defineProperty(unstorable.parts[0], "text", {
        enumerable: true,
        get: () => {
          throw new Error("unstorable");
        },
      });
      await expect(
        store.commit({
          putMessages: [message("a2", "a", 2), unstorable],
          putSessions: [session("a", { title: "changed" })],
        })
      ).rejects.toThrow("unstorable");
      await expect(store.getSession("a")).resolves.toStrictEqual(session("a"));
      await expect(ids(store, "a")).resolves.toEqual(["a1"]);
      await expect(ids(store, "b")).resolves.toEqual(["b1"]);
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

    it("runs a transaction's reads and commits through its view, which sees its own commits", async (context) => {
      const store = await fresh();
      if (store.transaction === undefined) {
        context.skip();
        return;
      }
      await store.commit({ putSessions: [session("a")] });

      const seen = await store.transaction(async (view) => {
        const current = await view.getSession("a");
        await view.commit({
          putMessages: [message("a1", "a", 1)],
          putSessions: [{ ...session("a"), title: current?.title ?? "none" }],
        });
        await view.commit({
          putMessages: [message("b1", "b", 1)],
          putSessions: [session("b")],
        });
        await view.commit({
          putMessages: [{ ...message("a1", "a", 1), status: "error" }],
        });
        return {
          a: await view.getSession("a"),
          a1: await view.getMessage("a1"),
          b: await view.listMessages("b"),
        };
      });

      expect(seen).toStrictEqual({
        a: session("a", { title: "none" }),
        a1: message("a1", "a", 1, { status: "error" }),
        b: [message("b1", "b", 1)],
      });
      await expect(store.getSession("a")).resolves.toStrictEqual(
        session("a", { title: "none" })
      );
      await expect(ids(store, "a")).resolves.toEqual(["a1"]);
      await expect(store.getMessage("a1")).resolves.toMatchObject({
        status: "error",
      });
      await expect(ids(store, "b")).resolves.toEqual(["b1"]);
    });

    it("runs a transaction that touches nothing", async (context) => {
      const store = await fresh();
      if (store.transaction === undefined) {
        context.skip();
        return;
      }

      await expect(store.transaction(() => Promise.resolve(7))).resolves.toBe(
        7
      );
    });

    it("keeps none of a transaction's commit when work throws after it", async (context) => {
      const store = await fresh();
      if (store.transaction === undefined) {
        context.skip();
        return;
      }
      await store.commit({ putSessions: [session("s")] });

      await expect(
        store.transaction(async (view) => {
          await view.commit({
            putSessions: [session("s", { title: "changed" })],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");

      await expect(store.getSession("s")).resolves.toStrictEqual(session("s"));
    });

    it("keeps none of a transaction's commits across sessions when work throws", async (context) => {
      const store = await fresh();
      if (store.transaction === undefined) {
        context.skip();
        return;
      }
      await store.commit({
        putMessages: [message("a1", "a", 1)],
        putSessions: [session("a")],
      });
      await store.commit({
        putMessages: [message("b1", "b", 1)],
        putSessions: [session("b")],
      });

      await expect(
        store.transaction(async (view) => {
          await view.commit({
            putMessages: [
              { ...message("a1", "a", 1), summarized: true },
              message("a2", "a", 2),
            ],
            putSessions: [session("a", { title: "changed" })],
          });
          await view.commit({
            putMessages: [message("b2", "b", 2)],
            putSessions: [session("b", { status: "archived" })],
          });
          await view.commit({
            putMessages: [message("c1", "c", 1)],
            putSessions: [session("c")],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");

      await expect(store.getSession("a")).resolves.toStrictEqual(session("a"));
      await expect(store.listMessages("a")).resolves.toStrictEqual([
        message("a1", "a", 1),
      ]);
      await expect(store.getSession("b")).resolves.toStrictEqual(session("b"));
      await expect(store.listMessages("b")).resolves.toStrictEqual([
        message("b1", "b", 1),
      ]);
      await expect(store.getSession("c")).resolves.toBeNull();
      await expect(store.getMessage("a2")).resolves.toBeNull();
      await expect(store.getMessage("b2")).resolves.toBeNull();
      await expect(store.getMessage("c1")).resolves.toBeNull();
    });

    it("keeps both of two overlapping commits through one view", async (context) => {
      const storage = await open();
      const store = storage("a");
      if (store.transaction === undefined) {
        context.skip();
        return;
      }
      await store.commit({ putSessions: [session("s")] });

      const seen = await store.transaction(async (view) => {
        await Promise.all([
          view.commit({ putMessages: [message("m1", "s", 1)] }),
          view.commit({ putMessages: [message("m2", "s", 2)] }),
        ]);
        return ids(view, "s");
      });

      expect(seen).toEqual(["m1", "m2"]);
      await expect(ids(store, "s")).resolves.toEqual(["m1", "m2"]);
      await expect(ids(storage("a"), "s")).resolves.toEqual(["m1", "m2"]);
    });

    it("takes a view's commit after one it refused", async (context) => {
      const store = await fresh();
      if (store.transaction === undefined) {
        context.skip();
        return;
      }
      await store.commit({ putSessions: [session("s")] });
      const unstorable = message("m1", "s", 1);
      Object.defineProperty(unstorable.parts[0], "text", {
        enumerable: true,
        get: () => {
          throw new Error("unstorable");
        },
      });

      await store.transaction(async (view) => {
        await expect(
          view.commit({ putMessages: [unstorable] })
        ).rejects.toThrow("unstorable");
        await view.commit({ putMessages: [message("m2", "s", 2)] });
      });

      await expect(ids(store, "s")).resolves.toEqual(["m2"]);
    });

    it("refuses at once a call to the store from inside its own transaction", async (context) => {
      const store = await fresh();
      const { transaction } = store;
      if (transaction === undefined) {
        context.skip();
        return;
      }
      await store.commit({ putSessions: [session("s")] });
      const calls: Record<string, () => Promise<unknown>> = {
        commit: () => store.commit({ putSessions: [session("x")] }),
        getMessage: () => store.getMessage("m"),
        getSession: () => store.getSession("s"),
        listMessages: () => store.listMessages("s"),
        transaction: () =>
          transaction.call(store, () => Promise.resolve(undefined)),
      };
      const ended = Promise.withResolvers<void>();
      let later: Promise<unknown> = Promise.resolve();

      const outcomes = await store.transaction?.(async (view) => {
        const settled: Record<string, string> = {};
        for (const [method, call] of Object.entries(calls)) {
          settled[method] = await settlesWithin(call(), 1000);
        }
        // Scheduled from inside, but run once the transaction has ended.
        later = ended.promise.then(() =>
          store.commit({ putSessions: [session("later")] })
        );
        await view.commit({ putSessions: [session("inside")] });
        return settled;
      });
      ended.resolve();

      expect(Object.keys(outcomes ?? {})).toEqual(Object.keys(calls));
      for (const outcome of Object.values(outcomes ?? {})) {
        expect(outcome).toMatch(REFUSAL);
      }
      await later;
      await store.commit({ putSessions: [session("after")] });
      for (const id of ["inside", "later", "after"]) {
        await expect(store.getSession(id)).resolves.toStrictEqual(session(id));
      }
      await expect(store.getSession("x")).resolves.toBeNull();
    });

    it("lands an outside commit only after a running transaction ends", async (context) => {
      const storage = await open();
      const store = storage("a");
      const outside = storage("a");
      if (store.transaction === undefined) {
        context.skip();
        return;
      }
      await store.commit({ putSessions: [session("s", { title: "0" })] });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let landed = false;

      const running = store.transaction(async (view) => {
        entered.resolve();
        await release.promise;
        const seen = await view.getSession("s");
        await view.commit({
          putSessions: [session("s", { title: `${seen?.title}+tx` })],
        });
      });
      await entered.promise;
      const plain = outside
        .commit({ putSessions: [session("s", { title: "outside" })] })
        .then(() => {
          landed = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(landed).toBe(false);
      release.resolve();
      await Promise.all([running, plain]);
      await expect(storage("a").getSession("s")).resolves.toMatchObject({
        title: "outside",
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

/** What a store's refusal of a call from inside its own transaction says. */
const REFUSAL = /refused: .*use the view/;

/**
 * How `promise` settled, as `refused: <message>` or `resolved`, or `still
 * pending` after `ms`: a hang becomes a failed assertion, not a stalled
 * suite.
 */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("still pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        (error: unknown) =>
          `refused: ${error instanceof Error ? error.message : String(error)}`
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
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
