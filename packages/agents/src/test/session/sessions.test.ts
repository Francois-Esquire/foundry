import { describe, expect, it, vi } from "vitest";
import type {
  CreateMessageInput,
  SummarizeInput,
  UpdateMessageInput,
  UpdateSessionInput,
} from "../../session/sessions";
import {
  messagesToSummarize,
  newSessionMessage,
  newSessionRecord,
  patchSessionMessage,
  patchSessionRecord,
  Sessions,
} from "../../session/sessions";
import type { SessionMessage, SessionPart } from "../../session/types";
import type { SessionStore } from "../../store";
import { InMemorySessionStore } from "../../store/memory";
import { recordingStore } from "../helpers/recording-store";
import { sessionStoreKinds } from "../helpers/session-stores";

const UNKNOWN_SESSION_PATTERN = /unknown session/;

const text = (t: string): SessionPart[] => [{ text: t, type: "text" }];

function req<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

async function seedMessages(
  sessions: Sessions,
  labels: string[]
): Promise<{ sessionId: string; ids: string[] }> {
  const session = await sessions.createSession();
  const ids: string[] = [];
  for (const label of labels) {
    const m = await sessions.appendMessage({
      parts: text(label),
      role: "user",
      sessionId: session.id,
    });
    ids.push(m.id);
  }
  return { ids, sessionId: session.id };
}

const labelOf = (m: SessionMessage): string =>
  m.parts[0]?.type === "text" ? m.parts[0].text : "";

describe("Sessions without a store", () => {
  it("keeps its sessions in memory", async () => {
    const sessions = new Sessions();
    const session = await sessions.createSession({ id: "s" });

    await expect(sessions.getSession("s")).resolves.toEqual(session);
  });
});

describe.each(sessionStoreKinds())("over %s", (_kind, open) => {
  describe("Sessions", () => {
    it("creates a session with defaults and reads it back", async () => {
      const sessions = new Sessions({ store: await open() });
      const session = await sessions.createSession();

      expect(session.id).toBeTruthy();
      expect(session.status).toBe("active");
      expect(session.title).toBeNull();
      expect(await sessions.getSession(session.id)).toEqual(session);
    });

    it("adopts a provided id (for resume) and an optional title", async () => {
      const sessions = new Sessions({ store: await open() });
      const session = await sessions.createSession({
        id: "known",
        title: "Hello",
      });

      expect(session.id).toBe("known");
      expect(session.title).toBe("Hello");
    });

    it("resumes, not resets, a session created again under its id", async () => {
      const sessions = new Sessions({ store: await open() });
      const first = await sessions.createSession({
        id: "known",
        title: "Hello",
      });
      const kept = await sessions.appendMessage({
        parts: text("kept"),
        role: "user",
        sessionId: "known",
      });

      // The append stamped the session; nothing else about it changed.
      await expect(
        sessions.createSession({ id: "known", title: "Other" })
      ).resolves.toEqual({ ...first, updatedAt: kept.createdAt });
      await expect(sessions.listMessages("known")).resolves.toHaveLength(1);
    });

    it("returns null for an unknown session", async () => {
      const sessions = new Sessions({ store: await open() });
      expect(await sessions.getSession("nope")).toBeNull();
    });

    it("appends messages and lists them in insertion order", async () => {
      const sessions = new Sessions({ store: await open() });
      const session = await sessions.createSession();

      const first = await sessions.appendMessage({
        parts: [{ text: "hi", type: "text" }],
        role: "user",
        sessionId: session.id,
      });
      const second = await sessions.appendMessage({
        parts: [{ text: "hello", type: "text" }],
        role: "assistant",
        sessionId: session.id,
      });

      const list = await sessions.listMessages(session.id);
      expect(list.map((m) => m.id)).toEqual([first.id, second.id]);
      expect(list[0]?.role).toBe("user");
      expect(list[1]?.parts).toEqual([{ text: "hello", type: "text" }]);
    });

    it("defaults message status to complete and stamps timestamps", async () => {
      const sessions = new Sessions({ store: await open() });
      const session = await sessions.createSession();
      const message = await sessions.appendMessage({
        parts: [],
        role: "user",
        sessionId: session.id,
      });

      expect(message.status).toBe("complete");
      expect(message.createdAt).toBeGreaterThan(0);
      expect(message.updatedAt).toBe(message.createdAt);
    });

    it("rejects an append to an unknown session", async () => {
      const sessions = new Sessions({ store: await open() });
      await expect(
        sessions.appendMessage({ parts: [], role: "user", sessionId: "ghost" })
      ).rejects.toThrow(UNKNOWN_SESSION_PATTERN);
    });

    it("updates a streaming message's parts and status", async () => {
      const sessions = new Sessions({ store: await open() });
      const session = await sessions.createSession();
      const message = await sessions.appendMessage({
        parts: [{ text: "", type: "text" }],
        role: "assistant",
        sessionId: session.id,
        status: "streaming",
      });

      const updated = await sessions.updateMessage(message.id, {
        parts: [{ text: "done", type: "text" }],
        status: "complete",
      });

      expect(updated?.status).toBe("complete");
      expect(updated?.parts).toEqual([{ text: "done", type: "text" }]);
    });

    it("returns null when updating a message that does not exist", async () => {
      const sessions = new Sessions({ store: await open() });
      expect(
        await sessions.updateMessage("nope", { status: "complete" })
      ).toBeNull();
    });

    it("patches a session's title and status", async () => {
      const sessions = new Sessions({ store: await open() });
      const session = await sessions.createSession();

      const updated = await sessions.updateSession(session.id, {
        status: "archived",
        title: "Renamed",
      });

      expect(updated?.title).toBe("Renamed");
      expect(updated?.status).toBe("archived");
    });

    it("isolates messages by session", async () => {
      const sessions = new Sessions({ store: await open() });
      const a = await sessions.createSession();
      const b = await sessions.createSession();
      await sessions.appendMessage({
        parts: text("a"),
        role: "user",
        sessionId: a.id,
      });

      expect(await sessions.listMessages(b.id)).toEqual([]);
    });

    it("writes and round-trips the parent linkage", async () => {
      const sessions = new Sessions({ store: await open() });
      const session = await sessions.createSession({
        parentMessageId: "m1",
        parentSessionId: "p1",
      });

      expect(session.parentSessionId).toBe("p1");
      expect(session.parentMessageId).toBe("m1");
      expect(await sessions.getSession(session.id)).toEqual(session);
    });

    it("freezes a provided recursion depth", async () => {
      const sessions = new Sessions({ store: await open() });
      const session = await sessions.createSession({ recursionDepth: 2 });

      expect(session.recursionDepth).toBe(2);
    });

    it("defaults linkage to null and recursion depth to undefined", async () => {
      const sessions = new Sessions({ store: await open() });
      const session = await sessions.createSession();

      expect(session.parentSessionId).toBeNull();
      expect(session.parentMessageId).toBeNull();
      expect(session.recursionDepth).toBeUndefined();
    });
  });

  describe("Sessions rules", () => {
    it("stamps the session's updatedAt with each message it appends or folds", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const sessions = new Sessions({ store: await open() });
        vi.setSystemTime(1000);
        await sessions.createSession({ id: "s" });
        vi.setSystemTime(2000);
        const first = await sessions.appendMessage({
          parts: text("m1"),
          role: "user",
          sessionId: "s",
        });
        expect((await sessions.getSession("s"))?.updatedAt).toBe(2000);

        vi.setSystemTime(3000);
        const second = await sessions.appendMessage({
          parts: text("m2"),
          role: "user",
          sessionId: "s",
        });
        vi.setSystemTime(4000);
        await sessions.updateMessage(first.id, { status: "error" });
        expect((await sessions.getSession("s"))?.updatedAt).toBe(3000);

        vi.setSystemTime(5000);
        await sessions.summarize({
          messageId: second.id,
          sessionId: "s",
          summary: { parts: text("S") },
        });
        expect((await sessions.getSession("s"))?.updatedAt).toBe(5000);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Sessions stamps against a clock that steps back", () => {
    it("never moves updatedAt backwards when a session or a message is updated", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const sessions = new Sessions({ store: await open() });
        vi.setSystemTime(10);
        await sessions.createSession({ id: "s" });
        const message = await sessions.appendMessage({
          parts: text("m1"),
          role: "user",
          sessionId: "s",
        });
        vi.setSystemTime(100);
        await sessions.updateSession("s", { title: "first" });
        await sessions.updateMessage(message.id, { status: "error" });
        vi.setSystemTime(50);
        const session = await sessions.updateSession("s", { title: "second" });
        const updated = await sessions.updateMessage(message.id, {
          status: "complete",
        });

        expect(session).toMatchObject({ title: "second", updatedAt: 100 });
        expect(updated).toMatchObject({ status: "complete", updatedAt: 100 });
        await expect(sessions.getSession("s")).resolves.toMatchObject({
          updatedAt: 100,
        });
        await expect(sessions.listMessages("s")).resolves.toMatchObject([
          { updatedAt: 100 },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never moves a session's updatedAt backwards", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const sessions = new Sessions({ store: await open() });
        vi.setSystemTime(1000);
        await sessions.createSession({ id: "s" });
        vi.setSystemTime(2000);
        await sessions.appendMessage({
          parts: text("m1"),
          role: "user",
          sessionId: "s",
        });
        vi.setSystemTime(1000);
        const late = await sessions.appendMessage({
          parts: text("m2"),
          role: "user",
          sessionId: "s",
        });

        expect(late.createdAt).toBe(1000);
        expect((await sessions.getSession("s"))?.updatedAt).toBe(2000);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Sessions over one store", () => {
    it("keeps both of two overlapping updates from two instances", async () => {
      const store = await open();
      const a = new Sessions({ store });
      const b = new Sessions({ store });
      await a.createSession({ id: "s" });

      await Promise.all([
        a.updateSession("s", { title: "renamed" }),
        b.updateSession("s", { status: "archived" }),
      ]);

      await expect(store.getSession("s")).resolves.toMatchObject({
        status: "archived",
        title: "renamed",
      });
    });

    it("files a session once when two instances create it together", async () => {
      const { store, writes } = recordingStore(await open());

      const [first, second] = await Promise.all([
        new Sessions({ store }).createSession({ id: "s", title: "first" }),
        new Sessions({ store }).createSession({ id: "s", title: "second" }),
      ]);

      expect(writes).toHaveLength(1);
      expect(second).toEqual(first);
    });

    it("serializes its own read-modify-writes over a store without transactions", async () => {
      const inner = await open();
      const store: SessionStore = {
        commit: (write) => inner.commit(write),
        getMessage: (id) => inner.getMessage(id),
        getSession: (id) => inner.getSession(id),
        listMessages: (sessionId) => inner.listMessages(sessionId),
      };
      const sessions = new Sessions({ store });
      await sessions.createSession({ id: "s" });

      await Promise.all([
        sessions.updateSession("s", { title: "renamed" }),
        sessions.updateSession("s", { status: "archived" }),
      ]);

      await expect(store.getSession("s")).resolves.toMatchObject({
        status: "archived",
        title: "renamed",
      });
    });
  });

  describe("Sessions.summarize", () => {
    it("marks the messages before the marker and creates a summary block", async () => {
      const sessions = new Sessions({ store: await open() });
      const { sessionId, ids } = await seedMessages(sessions, [
        "m1",
        "m2",
        "m3",
        "m4",
      ]);

      const result = await sessions.summarize({
        messageId: req(ids[2]),
        sessionId,
        summary: { parts: text("SUMMARY") },
      });

      if (result === null) {
        throw new Error("expected a summarize result");
      }
      expect(result.summarizedIds).toEqual([ids[0], ids[1]]);
      expect(result.summary.role).toBe("summary");
      expect(result.summary.summarized).toBe(false);

      const flags = new Map(
        (await sessions.listMessages(sessionId)).map((m) => [
          m.id,
          m.summarized ?? false,
        ])
      );
      expect(flags.get(req(ids[0]))).toBe(true);
      expect(flags.get(req(ids[1]))).toBe(true);
      expect(flags.get(req(ids[2]))).toBe(false);
    });

    it("skips already-summarized messages", async () => {
      const sessions = new Sessions({ store: await open() });
      const { sessionId, ids } = await seedMessages(sessions, [
        "m1",
        "m2",
        "m3",
      ]);
      await sessions.updateMessage(req(ids[0]), { summarized: true });

      const result = await sessions.summarize({
        messageId: req(ids[2]),
        sessionId,
        summary: { parts: text("S") },
      });

      expect(result?.summarizedIds).toEqual([ids[1]]);
    });

    it("writes the summary and every flip it stands for as one commit", async () => {
      const { store, writes } = recordingStore(await open());
      const sessions = new Sessions({ store });
      const { sessionId, ids } = await seedMessages(sessions, [
        "m1",
        "m2",
        "m3",
      ]);
      const seeded = writes.length;

      const result = await sessions.summarize({
        messageId: req(ids[2]),
        sessionId,
        summary: { parts: text("S") },
      });

      const made = writes.slice(seeded);
      expect(made).toHaveLength(1);
      expect(made[0]?.putMessages?.map((m) => m.id)).toEqual([
        ids[0],
        ids[1],
        result?.summary.id,
      ]);
    });

    it("leaves history unfolded when the summary write fails", async () => {
      const { store } = recordingStore(await open(), (write) => {
        if (write.putMessages?.some((m) => m.role === "summary")) {
          throw new Error("disk full");
        }
      });
      const sessions = new Sessions({ store });
      const { sessionId, ids } = await seedMessages(sessions, [
        "m1",
        "m2",
        "m3",
      ]);
      const before = await sessions.listMessages(sessionId);

      await expect(
        sessions.summarize({
          messageId: req(ids[2]),
          sessionId,
          summary: { parts: text("S") },
        })
      ).rejects.toThrow("disk full");
      await expect(sessions.listMessages(sessionId)).resolves.toEqual(before);
    });

    it("returns null when nothing precedes the marker", async () => {
      const sessions = new Sessions({ store: await open() });
      const { sessionId, ids } = await seedMessages(sessions, ["m1", "m2"]);

      expect(
        await sessions.summarize({
          messageId: req(ids[0]),
          sessionId,
          summary: { parts: text("S") },
        })
      ).toBeNull();
    });
  });

  describe("Sessions.activeMessages", () => {
    it("prepends the latest summary and drops summarized + summary-type rows", async () => {
      const sessions = new Sessions({ store: await open() });
      const { sessionId, ids } = await seedMessages(sessions, [
        "m1",
        "m2",
        "m3",
        "m4",
      ]);
      await sessions.summarize({
        messageId: req(ids[2]),
        sessionId,
        summary: { parts: text("SUMMARY") },
      });

      const active = await sessions.activeMessages(sessionId);
      expect(active.map((m) => m.role)).toEqual(["summary", "user", "user"]);
      expect(active.map(labelOf)).toEqual(["SUMMARY", "m3", "m4"]);
    });

    it("returns the raw active messages when there is no summary", async () => {
      const sessions = new Sessions({ store: await open() });
      const { sessionId } = await seedMessages(sessions, ["m1", "m2"]);

      expect((await sessions.activeMessages(sessionId)).map(labelOf)).toEqual([
        "m1",
        "m2",
      ]);
    });
  });

  describe("Sessions keeps every message in its JSON form", () => {
    class Point {
      readonly x = 1;
      readonly y = -0;
    }
    /** Parts and metadata as a caller may hand them over. */
    function handed(): Pick<SessionMessage, "metadata" | "parts"> {
      return {
        metadata: {
          output: {
            at: new Date(0),
            gone: undefined,
            list: [undefined, Number.NaN, () => 1],
            map: new Map([["k", 1]]),
            point: new Point(),
            zero: -0,
          },
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
        parts: [
          {
            input: { link: new URL("https://example.com/a"), skip: undefined },
            name: "probe",
            providerOptions: { google: { infinite: Number.POSITIVE_INFINITY } },
            toolCallId: "c",
            type: "tool_call",
          },
          {
            isError: undefined,
            output: -0,
            toolCallId: "c",
            type: "tool_result",
          },
          { text: "kept as is: \u0000 and \uD800", type: "text" },
        ],
      };
    }
    const KEPT: Pick<SessionMessage, "metadata" | "parts"> = {
      metadata: {
        output: {
          at: "1970-01-01T00:00:00.000Z",
          list: [null, null, null],
          map: {},
          point: { x: 1, y: 0 },
          zero: 0,
        },
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
      parts: [
        {
          input: { link: "https://example.com/a" },
          name: "probe",
          providerOptions: { google: { infinite: null } },
          toolCallId: "c",
          type: "tool_call",
        },
        { output: 0, toolCallId: "c", type: "tool_result" },
        { text: "kept as is: \u0000 and \uD800", type: "text" },
      ],
    };

    it("normalizes parts and metadata on append and update, and returns what it kept", async () => {
      const store = await open();
      const sessions = new Sessions({ store });
      await sessions.createSession({ id: "s" });

      const appended = await sessions.appendMessage({
        ...handed(),
        role: "assistant",
        sessionId: "s",
      });
      expect(appended).toMatchObject(KEPT);
      await expect(store.getMessage(appended.id)).resolves.toStrictEqual(
        appended
      );

      const updated = await sessions.updateMessage(appended.id, handed());
      expect(updated).toMatchObject(KEPT);
      await expect(store.listMessages("s")).resolves.toStrictEqual([updated]);
      const output = (updated?.parts[1] as { output?: number } | undefined)
        ?.output;
      expect(Object.is(output, 0)).toBe(true);
    });

    it("normalizes a summary and the messages it folds", async () => {
      const store = await open();
      const sessions = new Sessions({ store });
      const { sessionId, ids } = await seedMessages(sessions, ["m1", "m2"]);

      const result = await sessions.summarize({
        messageId: req(ids[1]),
        sessionId,
        summary: handed(),
      });

      expect(result?.summary).toMatchObject(KEPT);
      const [, , summary] = await store.listMessages(sessionId);
      expect(summary).toStrictEqual(result?.summary);
    });

    it.each([
      ["a bigint", { count: 1n }, "parts[0].input.count has no JSON form"],
      [
        "a value that contains itself",
        (() => {
          const self: Record<string, unknown> = {};
          self.again = { self };
          return self;
        })(),
        "parts[0].input.again.self has no JSON form",
      ],
      [
        "a getter that throws",
        Object.defineProperty({}, "broken", {
          enumerable: true,
          get: () => {
            throw new Error("unreadable");
          },
        }),
        "parts[0].input.broken has no JSON form: unreadable",
      ],
    ])(
      "refuses %s, naming its path, and writes nothing",
      async (_case, input, why) => {
        const store = await open();
        const sessions = new Sessions({ store });
        await sessions.createSession({ id: "s" });

        await expect(
          sessions.appendMessage({
            parts: [
              { input, name: "probe", toolCallId: "c", type: "tool_call" },
            ],
            role: "assistant",
            sessionId: "s",
          })
        ).rejects.toThrow(why);
        await expect(store.listMessages("s")).resolves.toEqual([]);
      }
    );

    it.each([
      [
        "a part that is a function",
        { parts: [() => 1] as unknown as SessionPart[] },
        "parts[0] holds null, not a part",
      ],
      [
        "a token count that is NaN",
        {
          metadata: {
            usage: { inputTokens: Number.NaN, outputTokens: 0, totalTokens: 0 },
          },
          parts: [],
        },
        "metadata.usage.inputTokens holds null, not an integer of at least 0",
      ],
      [
        "a text part whose text is undefined",
        {
          parts: [
            { text: undefined, type: "text" },
          ] as unknown as SessionPart[],
        },
        "parts[0].text is missing",
      ],
    ])(
      "refuses %s, whose JSON form is no message, and writes nothing",
      async (_case, fields, why) => {
        const store = await open();
        const sessions = new Sessions({ store });
        await sessions.createSession({ id: "s" });

        await expect(
          sessions.appendMessage({ ...fields, role: "user", sessionId: "s" })
        ).rejects.toThrow("[sessions] cannot keep message");
        await expect(
          sessions.appendMessage({ ...fields, role: "user", sessionId: "s" })
        ).rejects.toThrow(why);
        await expect(store.listMessages("s")).resolves.toEqual([]);
      }
    );
    it("refuses an update whose parts have no JSON form, as an append does, and keeps the old parts", async () => {
      const store = await open();
      const sessions = new Sessions({ store });
      await sessions.createSession({ id: "s" });
      const parts = Object.assign([{ text: "new", type: "text" }], {
        toJSON: () => undefined,
      }) as unknown as SessionPart[];
      const appended = await sessions.appendMessage({
        parts: [{ text: "old", type: "text" }],
        role: "user",
        sessionId: "s",
      });

      await expect(
        sessions.appendMessage({ parts, role: "user", sessionId: "s" })
      ).rejects.toThrow("[sessions] cannot keep message");
      await expect(
        sessions.updateMessage(appended.id, { parts })
      ).rejects.toThrow("[sessions] cannot keep message");
      await expect(store.getMessage(appended.id)).resolves.toStrictEqual(
        appended
      );
    });
  });

  describe("Sessions reads what a caller hands it once, when called", () => {
    it("keeps an appended message as it was handed over", async () => {
      const store = await open();
      const sessions = new Sessions({ store });
      await sessions.createSession({ id: "s" });
      const input: CreateMessageInput = {
        metadata: { model: { id: "before" } },
        parts: [{ text: "before", type: "text" }],
        role: "user",
        sessionId: "s",
      };

      const pending = sessions.appendMessage(input);
      (input.parts[0] as { text: string }).text = "after";
      (input.metadata as { model: { id: string } }).model.id = "after";
      input.role = "assistant";
      const appended = await pending;

      const kept = {
        metadata: { model: { id: "before" } },
        parts: [{ text: "before", type: "text" }],
        role: "user",
      };
      expect(appended).toMatchObject(kept);
      await expect(store.getMessage(appended.id)).resolves.toMatchObject(kept);
    });

    it("keeps an update, a summary and a session patch as they were handed over", async () => {
      const store = await open();
      const sessions = new Sessions({ store });
      const { sessionId, ids } = await seedMessages(sessions, ["m1", "m2"]);
      const update: UpdateMessageInput = {
        parts: [{ text: "before", type: "text" }],
        status: "error",
      };
      const fold: SummarizeInput = {
        messageId: req(ids[1]),
        sessionId,
        summary: { parts: [{ text: "summary before", type: "text" }] },
      };
      const rename: UpdateSessionInput = { title: "before" };

      const updating = sessions.updateMessage(req(ids[0]), update);
      (update.parts?.[0] as { text: string }).text = "after";
      update.status = "complete";
      await updating;
      const folding = sessions.summarize(fold);
      (fold.summary.parts[0] as { text: string }).text = "summary after";
      fold.messageId = "nowhere";
      const result = await folding;
      const renaming = sessions.updateSession(sessionId, rename);
      rename.title = "after";
      await renaming;

      await expect(store.getMessage(req(ids[0]))).resolves.toMatchObject({
        parts: [{ text: "before", type: "text" }],
        status: "error",
      });
      expect(result?.summary.parts).toEqual([
        { text: "summary before", type: "text" },
      ]);
      await expect(store.getSession(sessionId)).resolves.toMatchObject({
        title: "before",
      });
    });
  });
});

describe("session record and message builders", () => {
  it("leave absent optionals out, so a serialized record reads back unchanged", () => {
    const record = newSessionRecord({ id: "s1" }, 5);
    const message = newSessionMessage(
      { parts: text("hi"), role: "user", sessionId: "s1" },
      6
    );

    expect(record).toStrictEqual({
      createdAt: 5,
      id: "s1",
      parentMessageId: null,
      parentSessionId: null,
      status: "active",
      title: null,
      updatedAt: 5,
    });
    expect(JSON.parse(JSON.stringify(message))).toStrictEqual(message);
    expect(Object.keys(message)).not.toContain("metadata");
    expect(Object.keys(message)).not.toContain("summarized");
  });

  it("patch only the fields a patch sets and restamp updatedAt", () => {
    const record = newSessionRecord({ title: "t" }, 1);
    expect(patchSessionRecord(record, { status: "archived" }, 2)).toEqual({
      ...record,
      status: "archived",
      updatedAt: 2,
    });

    const message = newSessionMessage(
      { parts: text("a"), role: "assistant", sessionId: record.id },
      1
    );
    expect(patchSessionMessage(message, { summarized: true }, 3)).toEqual({
      ...message,
      summarized: true,
      updatedAt: 3,
    });
  });
});

describe("messagesToSummarize", () => {
  it("selects real messages before the marker (exclusive, no summaries)", () => {
    const msgs = [
      { id: "a", summarized: true },
      { id: "b" },
      { id: "s", role: "summary" },
      { id: "c" },
      { id: "d" },
    ] as SessionMessage[];

    expect(messagesToSummarize(msgs, "d").map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("is empty when the marker is absent or first", () => {
    const msgs = [{ id: "a" }, { id: "b" }] as SessionMessage[];
    expect(messagesToSummarize(msgs, "missing")).toEqual([]);
    expect(messagesToSummarize(msgs, "a")).toEqual([]);
  });
});

describe("Sessions over a store holding a field set to undefined", () => {
  it("writes records back without it", async () => {
    // Only the memory store can hold one; Sessions never hands one on.
    const inner = new InMemorySessionStore();
    await inner.commit({
      putMessages: [
        {
          createdAt: 1,
          id: "m",
          metadata: undefined,
          parts: [],
          role: "user",
          sessionId: "s",
          status: "complete",
          summarized: undefined,
          updatedAt: 1,
        },
      ],
      putSessions: [
        {
          createdAt: 1,
          id: "s",
          parentMessageId: null,
          parentSessionId: null,
          recursionDepth: undefined,
          status: "active",
          title: null,
          updatedAt: 1,
        },
      ],
    });
    const { store, writes } = recordingStore(inner);
    const sessions = new Sessions({ store });

    await sessions.updateMessage("m", { status: "error" });
    await sessions.updateSession("s", { title: "t" });
    await sessions.appendMessage({ parts: [], role: "user", sessionId: "s" });

    const written = writes.flatMap((write) => [
      ...(write.putMessages ?? []),
      ...(write.putSessions ?? []),
    ]);
    expect(written).toHaveLength(4);
    for (const record of written) {
      expect(
        Object.entries(record).filter(([, value]) => value === undefined)
      ).toEqual([]);
    }
  });
});

describe("Sessions over a store holding a message it would not write now", () => {
  it("folds it and sets its status, and refuses only new parts that are no message", async () => {
    // A part of a type the vocabulary no longer has, written by another writer.
    const legacy = {
      createdAt: 1,
      id: "old",
      parts: [{ note: "kept", type: "legacy_note" }],
      role: "user",
      sessionId: "s",
      status: "complete",
      updatedAt: 1,
    } as unknown as SessionMessage;
    const store = new InMemorySessionStore();
    await store.commit({
      putMessages: [legacy],
      putSessions: [
        {
          createdAt: 1,
          id: "s",
          parentMessageId: null,
          parentSessionId: null,
          status: "active",
          title: null,
          updatedAt: 1,
        },
      ],
    });
    const sessions = new Sessions({ store });
    const marker = await sessions.appendMessage({
      parts: text("now"),
      role: "user",
      sessionId: "s",
    });

    await expect(
      sessions.updateMessage("old", { status: "error" })
    ).resolves.toMatchObject({ parts: legacy.parts, status: "error" });
    await expect(
      sessions.summarize({
        messageId: marker.id,
        sessionId: "s",
        summary: { parts: text("S") },
      })
    ).resolves.toMatchObject({ summarizedIds: ["old"] });
    await expect(
      sessions.updateMessage("old", {
        parts: [{ type: "legacy_note" }] as unknown as SessionPart[],
      })
    ).rejects.toThrow(
      'parts[0].type holds "legacy_note", which is no part type'
    );
  });
});
