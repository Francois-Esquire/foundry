import { describe, expect, it } from "vitest";

import type {
  SessionChangeEvent,
  SessionMessage,
  SessionPart,
  SessionRecord,
} from "../schema";
import type { SessionStore } from "../store";

export type SessionStorage = (scope: string) => SessionStore;

export interface RecordingSessionStorage {
  readonly failNextCommit: () => void;
  readonly recorded: () => Promise<readonly SessionChangeEvent[]>;
  readonly storage: SessionStorage;
}

export type SessionStoreMode =
  | { readonly hooked: false }
  | {
      readonly hooked: true;
      readonly recording: () => Promise<RecordingSessionStorage>;
    };

export function describeSessionStore(
  name: string,
  open: () => SessionStorage | Promise<SessionStorage>,
  mode: SessionStoreMode
): void {
  const fresh = async (): Promise<SessionStore> => (await open())("scope");

  describe(`${name} (SessionStore events)`, () => {
    it("keeps no event: a write's events change no record", async () => {
      const store = await fresh();
      await store.commit({
        events: [created("s"), appended("s", ["m1"])],
        putMessages: [message("m1", "s", 1)],
        putSessions: [session("s")],
      });
      await store.commit({ events: [updated("s")] });

      await expect(store.getSession("s")).resolves.toStrictEqual(session("s"));
      await expect(store.listMessages("s")).resolves.toStrictEqual([
        message("m1", "s", 1),
      ]);
    });

    it.each(UNPLAIN_EVENTS)(
      "refuses whole, with a TypeError, a write whose events are %s",
      async (_kind, events) => {
        const store = await fresh();

        await expect(
          store.commit({ events: events(), putSessions: [session("s")] })
        ).rejects.toThrow(TypeError);
        await expect(store.getSession("s")).resolves.toBeNull();
      }
    );

    it.each(UNPLAIN_EVENTS)(
      "refuses through a transaction's view a write whose events are %s",
      async (_kind, events) => {
        const store = await fresh();
        if (store.transaction === undefined) {
          return;
        }

        await store.transaction(async (view) => {
          await expect(
            view.commit({ events: events(), putSessions: [session("s")] })
          ).rejects.toThrow(TypeError);
          await view.commit({ putSessions: [session("kept")] });
        });
        await expect(store.getSession("s")).resolves.toBeNull();
        await expect(store.getSession("kept")).resolves.toStrictEqual(
          session("kept")
        );
      }
    );
  });

  if (mode.hooked) {
    describeRecordedEvents(name, mode.recording);
  }

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

    it("moves a message to the end of its new session, and the next one follows it", async () => {
      const store = await fresh();
      await store.commit({
        putMessages: [
          message("a1", "a", 1),
          message("a2", "a", 2),
          message("b1", "b", 1),
          message("b2", "b", 2),
        ],
        putSessions: [session("a"), session("b")],
      });
      await store.commit({ putMessages: [message("a1", "b", 1)] });
      await store.commit({
        putMessages: [message("b3", "b", 3), message("a3", "a", 3)],
      });

      await expect(ids(store, "a")).resolves.toEqual(["a2", "a3"]);
      await expect(ids(store, "b")).resolves.toEqual(["b1", "b2", "a1", "b3"]);
    });

    it("files each message after every one its session holds, after its last one moved away", async () => {
      const store = await fresh();
      await store.commit({
        putMessages: [message("a1", "a", 1), message("a2", "a", 2)],
        putSessions: [session("a"), session("b")],
      });
      await store.commit({ putMessages: [message("a2", "b", 2)] });
      await store.commit({ putMessages: [message("a3", "a", 3)] });
      await store.commit({ putMessages: [message("a2", "a", 2)] });
      await store.commit({ putMessages: [message("a4", "a", 4)] });

      await expect(ids(store, "a")).resolves.toEqual(["a1", "a3", "a2", "a4"]);
      await expect(ids(store, "b")).resolves.toEqual([]);
    });

    it("places a message put more than once in one write as its puts, in order, leave it", async () => {
      const store = await fresh();
      await store.commit({
        putMessages: [message("m1", "a", 1), message("m2", "a", 2)],
        putSessions: [session("a"), session("b"), session("n")],
      });
      const last = message("m1", "a", 1, { status: "error" });
      await store.commit({
        putMessages: [
          message("m1", "b", 1),
          message("n1", "a", 3),
          last,
          message("n2", "n", 1),
          message("n2", "n", 1, { status: "streaming" }),
        ],
      });

      await expect(ids(store, "a")).resolves.toEqual(["m2", "n1", "m1"]);
      await expect(ids(store, "b")).resolves.toEqual([]);
      await expect(store.getMessage("m1")).resolves.toStrictEqual(last);
      await expect(store.listMessages("n")).resolves.toStrictEqual([
        message("n2", "n", 1, { status: "streaming" }),
      ]);
    });

    it("keeps the last of a session put more than once in one write", async () => {
      const store = await fresh();
      await store.commit({
        putSessions: [
          session("s", { title: "first" }),
          session("s", { title: "last" }),
        ],
      });

      await expect(store.getSession("s")).resolves.toStrictEqual(
        session("s", { title: "last" })
      );
    });

    it("reads every field back as written, a field left out still left out", async () => {
      const store = await fresh();
      const root = session("root");
      const child = session("child", {
        parentMessageId: "full",
        parentSessionId: "root",
        recursionDepth: 0,
        status: "error",
        title: "",
      });
      const full = message("full", "root", 2, {
        metadata: FULL_METADATA,
        parts: EVERY_PART,
        role: "assistant",
        status: "streaming",
        summarized: false,
        updatedAt: 3,
      });
      const bare = message("bare", "root", 4, { parts: [], role: "summary" });
      const folded = message("folded", "root", 5, {
        role: "tool",
        summarized: true,
      });
      await store.commit({
        putMessages: [full, bare, folded],
        putSessions: [root, child],
      });

      await expect(store.getSession("root")).resolves.toStrictEqual(root);
      await expect(store.getSession("child")).resolves.toStrictEqual(child);
      await expect(store.listMessages("root")).resolves.toStrictEqual([
        full,
        bare,
        folded,
      ]);
      await expect(store.getMessage("full")).resolves.toStrictEqual(full);
      const read = await store.getMessage("bare");
      expect(read !== null && "metadata" in read).toBe(false);
      expect(read !== null && "summarized" in read).toBe(false);
      const parent = await store.getSession("root");
      expect(parent !== null && "recursionDepth" in parent).toBe(false);
    });

    it("gives back exactly the own properties it was given, and none holding undefined", async () => {
      const store = await fresh();
      const root = session("root", { recursionDepth: 1 });
      const full = message("full", "root", 2, {
        metadata: FULL_METADATA,
        parts: EVERY_PART,
        summarized: false,
      });
      const bare = message("bare", "root", 3);
      await store.commit({ putMessages: [full, bare], putSessions: [root] });

      const read = {
        listed: await store.listMessages("root"),
        message: await store.getMessage("full"),
        session: await store.getSession("root"),
      };
      expect(read).toStrictEqual({
        listed: [full, bare],
        message: full,
        session: root,
      });
      expect(ownPaths(read)).toEqual(
        ownPaths({ listed: [full, bare], message: full, session: root })
      );
      expect(
        ownPaths(read).filter((path) => path.endsWith("=undefined"))
      ).toEqual([]);
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

    it("keeps a write as it was when commit was called, whatever its caller changes after", async () => {
      const store = await fresh();
      await store.commit({ putSessions: [session("s")] });
      const written = message("m1", "s", 1);
      const record = session("s", { title: "before" });

      const pending = store.commit({
        putMessages: [written],
        putSessions: [record],
      });
      (written.parts[0] as { text: string }).text = "after";
      written.status = "error";
      record.title = "after";
      await pending;

      await expect(store.getMessage("m1")).resolves.toStrictEqual(
        message("m1", "s", 1)
      );
      await expect(store.getSession("s")).resolves.toStrictEqual(
        session("s", { title: "before" })
      );
    });

    it("keeps a commit queued behind a transaction as it was when called", async (context) => {
      const store = await fresh();
      if (store.transaction === undefined) {
        context.skip();
        return;
      }
      await store.commit({ putSessions: [session("s")] });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const running = store.transaction(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const written = message("m1", "s", 1);

      const queued = store.commit({ putMessages: [written] });
      (written.parts[0] as { text: string }).text = "after";
      release.resolve();
      await Promise.all([running, queued]);

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

const FULL_METADATA: SessionMessage["metadata"] = {
  harnessEnvironment: { harness: "codex", id: "env-1" },
  model: { harness: "codex", id: "model", provider: "openai" },
  notification: { kind: "completion", taskId: "task-1" },
  output: { empty: {}, list: [1, -2.5, "three", null, true, { deep: [[]] }] },
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  timing: { completedAt: 20, durationMs: -5, startedAt: 25 },
  usage: {
    cachedInputTokens: 1,
    cacheWriteTokens: 2,
    inputTokens: 3,
    outputTokens: 4,
    reasoningTokens: 5,
    totalTokens: 7,
  },
};

const EVERY_PART: SessionPart[] = [
  { text: "plain, then \u00e9 and \u{1F600}", type: "text" },
  { text: "", type: "reasoning" },
  { mediaType: "image/png", type: "image", url: "data:image/png;base64,AA==" },
  { type: "image", url: "https://example.test/a.png" },
  {
    input: { nested: { list: [1, "two", null] }, text: "in" },
    name: "read",
    provenance: {
      agentGeneration: 1,
      agentId: "agent",
      effectLocation: "host",
      invocationId: "inv",
      source: "builtin",
    },
    providerOptions: { google: { thoughtSignature: "sig" } },
    toolCallId: "call-1",
    type: "tool_call",
  },
  { input: null, name: "noop", toolCallId: "call-2", type: "tool_call" },
  {
    isError: true,
    output: ["out", 2],
    toolCallId: "call-1",
    type: "tool_result",
  },
  { output: "plain", toolCallId: "call-2", type: "tool_result" },
  { message: "failed", type: "error" },
  {
    approvalId: "ap-1",
    approvalMode: "deferred",
    capability: { kind: "tool.call", source: "builtin", tool: "read" },
    input: { path: "/a" },
    name: "read",
    toolCallId: "call-1",
    type: "tool_approval_request",
  },
  {
    approvalId: "ap-1",
    approved: false,
    reason: "no",
    scope: "once",
    type: "tool_approval_response",
  },
  {
    harness: "codex",
    nativeSessionId: "native",
    type: "harness_session",
  },
  {
    activityId: "act",
    answerCount: 1,
    harness: "codex",
    outcome: "answered",
    questionCount: 2,
    toolCallId: "call-3",
    type: "harness_question",
  },
  {
    event: {
      agentId: "agent",
      harness: "codex",
      inputSummary: "ls",
      outcome: "ran",
      sessionId: "root",
      toolCallId: "call-4",
      toolName: "shell",
    },
    type: "harness_tool",
  },
  {
    event: {
      actions: ["stop"],
      agentId: "agent",
      harness: "codex",
      id: "act",
      kind: "subagent",
      lifetime: "session",
      revision: 1,
      sessionId: "root",
      status: "running",
      title: "child",
    },
    type: "harness_activity",
  },
];

function describeRecordedEvents(
  name: string,
  recording: () => Promise<RecordingSessionStorage>
): void {
  const recorder = async () => {
    const opened = await recording();
    return { ...opened, store: opened.storage("scope") };
  };

  describe(`${name} (SessionStore events handed to the host)`, () => {
    it("hands on each commit's events once, in order, and none for a write without", async () => {
      const { recorded, store } = await recorder();
      const first = [created("s"), appended("s", ["m1", "m2"])];
      await store.commit({
        events: first,
        putMessages: [message("m1", "s", 1), message("m2", "s", 2)],
        putSessions: [session("s")],
      });
      await store.commit({ putMessages: [message("m3", "s", 3)] });
      await store.commit({ events: [updated("s")] });

      await expect(recorded()).resolves.toStrictEqual([...first, updated("s")]);
    });

    it("hands on the events as they were when commit was called", async () => {
      const { recorded, store } = await recorder();
      const event = appended("s", ["m1"]);

      const pending = store.commit({
        events: [event],
        putSessions: [session("s")],
      });
      if (event.type === "session.messages.appended") {
        event.messageIds.push("later");
      }
      await pending;

      await expect(recorded()).resolves.toStrictEqual([appended("s", ["m1"])]);
    });

    it("records nothing for a write whose events it refuses", async () => {
      const { recorded, store } = await recorder();
      for (const [, events] of UNPLAIN_EVENTS) {
        await expect(
          store.commit({ events: events(), putSessions: [session("s")] })
        ).rejects.toThrow(TypeError);
      }
      await expect(recorded()).resolves.toStrictEqual([]);
    });

    it("records nothing for a write it refuses", async () => {
      const { recorded, store } = await recorder();
      const unstorable = message("m1", "s", 1);
      Object.defineProperty(unstorable.parts[0], "text", {
        enumerable: true,
        get: () => {
          throw new Error("unstorable");
        },
      });

      await expect(
        store.commit({
          events: [created("s")],
          putMessages: [unstorable],
          putSessions: [session("s")],
        })
      ).rejects.toThrow("unstorable");
      await expect(recorded()).resolves.toStrictEqual([]);
    });

    it("runs the hook inside the commit: a throw from it keeps neither the write nor its events", async () => {
      const { failNextCommit, recorded, store } = await recorder();
      failNextCommit();

      await expect(
        store.commit({ events: [created("s")], putSessions: [session("s")] })
      ).rejects.toThrow();
      await expect(store.getSession("s")).resolves.toBeNull();
      await expect(recorded()).resolves.toStrictEqual([]);

      await store.commit({
        events: [created("s")],
        putSessions: [session("s")],
      });
      await expect(recorded()).resolves.toStrictEqual([created("s")]);
    });

    it("records a transaction's events only when it is kept", async (context) => {
      const { recorded, store } = await recorder();
      if (store.transaction === undefined) {
        context.skip();
        return;
      }

      await expect(
        store.transaction(async (view) => {
          await view.commit({
            events: [created("dropped")],
            putSessions: [session("dropped")],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      await store.transaction(async (view) => {
        await view.commit({
          events: [created("s")],
          putSessions: [session("s")],
        });
        await view.commit({
          events: [appended("s", ["m1"])],
          putMessages: [message("m1", "s", 1)],
        });
      });

      await expect(recorded()).resolves.toStrictEqual([
        created("s"),
        appended("s", ["m1"]),
      ]);
    });
  });
}

const AT = "2026-01-01T00:00:00.000Z";

const UNPLAIN_EVENTS: [string, () => SessionChangeEvent[]][] = [
  [
    "a class instance",
    () => {
      class Created {
        readonly at = AT;
        readonly id = "e";
        readonly sessionId = "s";
        readonly type = "session.created";
      }
      return [new Created() as unknown as SessionChangeEvent];
    },
  ],
  [
    "an object with an own property a copy would not see",
    () => {
      const event = { ...created("s") };
      Object.defineProperty(event, "id", { enumerable: false, value: "e" });
      return [event];
    },
  ],
  [
    "an object with a symbol key",
    () => [{ ...created("s"), [Symbol("extra")]: 1 } as SessionChangeEvent],
  ],
  [
    "an object holding a Date",
    () => [
      { ...created("s"), at: new Date(0) } as unknown as SessionChangeEvent,
    ],
  ],
  [
    "an object holding undefined",
    () => [
      { ...created("s"), extra: undefined } as unknown as SessionChangeEvent,
    ],
  ],
  [
    "an object holding NaN",
    () => [
      { ...created("s"), extra: Number.NaN } as unknown as SessionChangeEvent,
    ],
  ],
  [
    "not an array",
    () => ({ 0: created("s"), length: 1 }) as unknown as SessionChangeEvent[],
  ],
  [
    "an Array subclass",
    () => {
      class Events extends Array<SessionChangeEvent> {}
      return Events.from([created("s")]);
    },
  ],
  [
    "an array holding an Array subclass",
    () => {
      class Ids extends Array<string> {}
      return [
        {
          ...created("s"),
          extra: Ids.from(["a"]),
        } as unknown as SessionChangeEvent,
      ];
    },
  ],
  [
    "an array holding an array with a hidden function",
    () => {
      const items = ["a"];
      Object.defineProperty(items, "hidden", { value: () => undefined });
      return [
        { ...created("s"), extra: items } as unknown as SessionChangeEvent,
      ];
    },
  ],
  [
    "an array holding an array with a symbol key",
    () => {
      const items = Object.assign(["a"], { [Symbol("extra")]: 1 });
      return [
        { ...created("s"), extra: items } as unknown as SessionChangeEvent,
      ];
    },
  ],
  [
    "an array with an own property beyond its items",
    () => Object.assign([created("s")], { "-1": created("s") }),
  ],
];

function created(sessionId: string): SessionChangeEvent {
  return {
    at: AT,
    id: `created-${sessionId}`,
    sessionId,
    type: "session.created",
  };
}

function updated(sessionId: string): SessionChangeEvent {
  return {
    at: AT,
    id: `updated-${sessionId}`,
    sessionId,
    type: "session.updated",
  };
}

function appended(sessionId: string, messageIds: string[]): SessionChangeEvent {
  return {
    at: AT,
    id: `appended-${sessionId}-${messageIds.join("-")}`,
    messageIds,
    sessionId,
    type: "session.messages.appended",
  };
}

const REFUSAL = /refused: .*use the view/;

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

function ownPaths(value: unknown, at = "$"): string[] {
  if (value === undefined) {
    return [`${at}=undefined`];
  }
  if (typeof value !== "object" || value === null) {
    return [at];
  }
  return [
    at,
    ...Object.keys(value)
      .sort()
      .flatMap((key) =>
        ownPaths((value as Record<string, unknown>)[key], `${at}.${key}`)
      ),
  ];
}

async function ids(store: SessionStore, sessionId: string): Promise<string[]> {
  return (await store.listMessages(sessionId)).map((m) => m.id);
}
