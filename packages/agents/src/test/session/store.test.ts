import { describe, expect, it } from "vitest";
import { InMemorySessionStore, messagesToSummarize } from "../../session/store";
import type { SessionMessage, SessionPart } from "../../session/types";

const text = (t: string): SessionPart[] => [{ text: t, type: "text" }];

function req<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

async function seedMessages(
  store: InMemorySessionStore,
  labels: string[]
): Promise<{ sessionId: string; ids: string[] }> {
  const session = await store.createSession();
  const ids: string[] = [];
  for (const label of labels) {
    const m = await store.appendMessage({
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

describe("InMemorySessionStore", () => {
  it("creates a session with defaults and reads it back", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession();

    expect(session.id).toBeTruthy();
    expect(session.status).toBe("active");
    expect(session.title).toBeNull();
    expect(await store.getSession(session.id)).toEqual(session);
  });

  it("adopts a provided id (for resume) and an optional title", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ id: "known", title: "Hello" });

    expect(session.id).toBe("known");
    expect(session.title).toBe("Hello");
  });

  it("returns null for an unknown session", async () => {
    const store = new InMemorySessionStore();
    expect(await store.getSession("nope")).toBeNull();
  });

  it("appends messages and lists them in insertion order", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession();

    const first = await store.appendMessage({
      parts: [{ text: "hi", type: "text" }],
      role: "user",
      sessionId: session.id,
    });
    const second = await store.appendMessage({
      parts: [{ text: "hello", type: "text" }],
      role: "assistant",
      sessionId: session.id,
    });

    const list = await store.listMessages(session.id);
    expect(list.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(list[0]?.role).toBe("user");
    expect(list[1]?.parts).toEqual([{ text: "hello", type: "text" }]);
  });

  it("defaults message status to complete and stamps timestamps", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession();
    const message = await store.appendMessage({
      parts: [],
      role: "user",
      sessionId: session.id,
    });

    expect(message.status).toBe("complete");
    expect(message.createdAt).toBeGreaterThan(0);
    expect(message.updatedAt).toBe(message.createdAt);
  });

  it("rejects an append to an unknown session", async () => {
    const store = new InMemorySessionStore();
    await expect(
      store.appendMessage({ parts: [], role: "user", sessionId: "ghost" })
    ).rejects.toThrow(/unknown session/);
  });

  it("updates a streaming message's parts and status", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession();
    const message = await store.appendMessage({
      parts: [{ text: "", type: "text" }],
      role: "assistant",
      sessionId: session.id,
      status: "streaming",
    });

    const updated = await store.updateMessage(message.id, {
      parts: [{ text: "done", type: "text" }],
      status: "complete",
    });

    expect(updated?.status).toBe("complete");
    expect(updated?.parts).toEqual([{ text: "done", type: "text" }]);
  });

  it("returns null when updating a message that does not exist", async () => {
    const store = new InMemorySessionStore();
    expect(
      await store.updateMessage("nope", { status: "complete" })
    ).toBeNull();
  });

  it("patches a session's title and status", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession();

    const updated = await store.updateSession(session.id, {
      status: "archived",
      title: "Renamed",
    });

    expect(updated?.title).toBe("Renamed");
    expect(updated?.status).toBe("archived");
  });

  it("isolates messages by session", async () => {
    const store = new InMemorySessionStore();
    const a = await store.createSession();
    const b = await store.createSession();
    await store.appendMessage({
      parts: text("a"),
      role: "user",
      sessionId: a.id,
    });

    expect(await store.listMessages(b.id)).toEqual([]);
  });

  it("writes and round-trips the parent linkage", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({
      parentMessageId: "m1",
      parentSessionId: "p1",
    });

    expect(session.parentSessionId).toBe("p1");
    expect(session.parentMessageId).toBe("m1");
    expect(await store.getSession(session.id)).toEqual(session);
  });

  it("freezes a provided recursion depth", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ recursionDepth: 2 });

    expect(session.recursionDepth).toBe(2);
  });

  it("defaults linkage to null and recursion depth to undefined", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession();

    expect(session.parentSessionId).toBeNull();
    expect(session.parentMessageId).toBeNull();
    expect(session.recursionDepth).toBeUndefined();
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

describe("AbstractSessionStore.summarize", () => {
  it("marks the messages before the marker and creates a summary block", async () => {
    const store = new InMemorySessionStore();
    const { sessionId, ids } = await seedMessages(store, [
      "m1",
      "m2",
      "m3",
      "m4",
    ]);

    const result = await store.summarize({
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
      (await store.listMessages(sessionId)).map((m) => [
        m.id,
        m.summarized ?? false,
      ])
    );
    expect(flags.get(req(ids[0]))).toBe(true);
    expect(flags.get(req(ids[1]))).toBe(true);
    expect(flags.get(req(ids[2]))).toBe(false);
  });

  it("skips already-summarized messages", async () => {
    const store = new InMemorySessionStore();
    const { sessionId, ids } = await seedMessages(store, ["m1", "m2", "m3"]);
    await store.updateMessage(req(ids[0]), { summarized: true });

    const result = await store.summarize({
      messageId: req(ids[2]),
      sessionId,
      summary: { parts: text("S") },
    });

    expect(result?.summarizedIds).toEqual([ids[1]]);
  });

  it("returns null when nothing precedes the marker", async () => {
    const store = new InMemorySessionStore();
    const { sessionId, ids } = await seedMessages(store, ["m1", "m2"]);

    expect(
      await store.summarize({
        messageId: req(ids[0]),
        sessionId,
        summary: { parts: text("S") },
      })
    ).toBeNull();
  });
});

describe("AbstractSessionStore.activeMessages", () => {
  it("prepends the latest summary and drops summarized + summary-type rows", async () => {
    const store = new InMemorySessionStore();
    const { sessionId, ids } = await seedMessages(store, [
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    await store.summarize({
      messageId: req(ids[2]),
      sessionId,
      summary: { parts: text("SUMMARY") },
    });

    const active = await store.activeMessages(sessionId);
    expect(active.map((m) => m.role)).toEqual(["summary", "user", "user"]);
    expect(active.map(labelOf)).toEqual(["SUMMARY", "m3", "m4"]);
  });

  it("returns the raw active messages when there is no summary", async () => {
    const store = new InMemorySessionStore();
    const { sessionId } = await seedMessages(store, ["m1", "m2"]);

    expect((await store.activeMessages(sessionId)).map(labelOf)).toEqual([
      "m1",
      "m2",
    ]);
  });
});
