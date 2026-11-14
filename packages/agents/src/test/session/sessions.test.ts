import { describe, expect, it, vi } from "vitest";
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

describe("Sessions", () => {
  it("creates a session with defaults and reads it back", async () => {
    const sessions = new Sessions();
    const session = await sessions.createSession();

    expect(session.id).toBeTruthy();
    expect(session.status).toBe("active");
    expect(session.title).toBeNull();
    expect(await sessions.getSession(session.id)).toEqual(session);
  });

  it("adopts a provided id (for resume) and an optional title", async () => {
    const sessions = new Sessions();
    const session = await sessions.createSession({
      id: "known",
      title: "Hello",
    });

    expect(session.id).toBe("known");
    expect(session.title).toBe("Hello");
  });

  it("resumes, not resets, a session created again under its id", async () => {
    const sessions = new Sessions();
    const first = await sessions.createSession({ id: "known", title: "Hello" });
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
    const sessions = new Sessions();
    expect(await sessions.getSession("nope")).toBeNull();
  });

  it("appends messages and lists them in insertion order", async () => {
    const sessions = new Sessions();
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
    const sessions = new Sessions();
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
    const sessions = new Sessions();
    await expect(
      sessions.appendMessage({ parts: [], role: "user", sessionId: "ghost" })
    ).rejects.toThrow(UNKNOWN_SESSION_PATTERN);
  });

  it("updates a streaming message's parts and status", async () => {
    const sessions = new Sessions();
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
    const sessions = new Sessions();
    expect(
      await sessions.updateMessage("nope", { status: "complete" })
    ).toBeNull();
  });

  it("patches a session's title and status", async () => {
    const sessions = new Sessions();
    const session = await sessions.createSession();

    const updated = await sessions.updateSession(session.id, {
      status: "archived",
      title: "Renamed",
    });

    expect(updated?.title).toBe("Renamed");
    expect(updated?.status).toBe("archived");
  });

  it("isolates messages by session", async () => {
    const sessions = new Sessions();
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
    const sessions = new Sessions();
    const session = await sessions.createSession({
      parentMessageId: "m1",
      parentSessionId: "p1",
    });

    expect(session.parentSessionId).toBe("p1");
    expect(session.parentMessageId).toBe("m1");
    expect(await sessions.getSession(session.id)).toEqual(session);
  });

  it("freezes a provided recursion depth", async () => {
    const sessions = new Sessions();
    const session = await sessions.createSession({ recursionDepth: 2 });

    expect(session.recursionDepth).toBe(2);
  });

  it("defaults linkage to null and recursion depth to undefined", async () => {
    const sessions = new Sessions();
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
      const sessions = new Sessions();
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

describe("Sessions over one store", () => {
  it("keeps both of two overlapping updates from two instances", async () => {
    const store = new InMemorySessionStore();
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
    const store = new InMemorySessionStore();
    const commit = vi.spyOn(store, "commit");

    const [first, second] = await Promise.all([
      new Sessions({ store }).createSession({ id: "s", title: "first" }),
      new Sessions({ store }).createSession({ id: "s", title: "second" }),
    ]);

    expect(commit).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it("serializes its own read-modify-writes over a store without transactions", async () => {
    const inner = new InMemorySessionStore();
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

describe("Sessions.summarize", () => {
  it("marks the messages before the marker and creates a summary block", async () => {
    const sessions = new Sessions();
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
    const sessions = new Sessions();
    const { sessionId, ids } = await seedMessages(sessions, ["m1", "m2", "m3"]);
    await sessions.updateMessage(req(ids[0]), { summarized: true });

    const result = await sessions.summarize({
      messageId: req(ids[2]),
      sessionId,
      summary: { parts: text("S") },
    });

    expect(result?.summarizedIds).toEqual([ids[1]]);
  });

  it("writes the summary and every flip it stands for as one commit", async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ store });
    const { sessionId, ids } = await seedMessages(sessions, ["m1", "m2", "m3"]);
    const commit = vi.spyOn(store, "commit");

    const result = await sessions.summarize({
      messageId: req(ids[2]),
      sessionId,
      summary: { parts: text("S") },
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0].putMessages?.map((m) => m.id)).toEqual([
      ids[0],
      ids[1],
      result?.summary.id,
    ]);
  });

  it("leaves history unfolded when the summary write fails", async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ store });
    const { sessionId, ids } = await seedMessages(sessions, ["m1", "m2", "m3"]);
    const before = await sessions.listMessages(sessionId);
    vi.spyOn(store, "commit").mockRejectedValueOnce(new Error("disk full"));

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
    const sessions = new Sessions();
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
    const sessions = new Sessions();
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
    const sessions = new Sessions();
    const { sessionId } = await seedMessages(sessions, ["m1", "m2"]);

    expect((await sessions.activeMessages(sessionId)).map(labelOf)).toEqual([
      "m1",
      "m2",
    ]);
  });
});
