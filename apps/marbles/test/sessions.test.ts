import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPart, SessionStore } from "@foundry/agents/session";
import { agent, step } from "@foundry/marbles";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { catalog } from "~/authoring/catalog";
import { CLAUDE_CODE } from "~/lib/harnesses";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import { sessionLines } from "~/sessions/list";

import type { MockBindings } from "./helpers/bindings";
import { bindMock } from "./helpers/bindings";
import { launch } from "./helpers/launch";

let mock: MockBindings | undefined;

afterEach(async () => {
  catalog.reset();
  vi.useRealTimers();
  await mock?.dispose();
  mock = undefined;
});

const text = z.object({ text: z.string() });

function bind(sessions: SessionStore) {
  mock = bindMock(
    ({ prompt }) => (prompt.includes("Summarize") ? "the gist" : "noted"),
    { executors: [CLAUDE_CODE], sessions }
  );
}

describe("JsonSessionStore", () => {
  it("survives a new process: a fresh store over the same dir sees the turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    bind(new JsonSessionStore(dir));
    const reviewer = agent({ prompt: "Review." });
    const ask = step("ask")
      .input(text)
      .do(async ({ agents, input }) => {
        const session = await agents.session(reviewer, {
          session: { id: "nightly" },
        });
        await session.generate(input.text);
        return session.ref.id;
      });
    await expect(launch(ask, { text: "first" })).resolves.toBe("nightly");
    await expect(launch(ask, { text: "second" })).resolves.toBe("nightly");

    const reopened = new JsonSessionStore(dir);
    const [record] = reopened.sessions();
    expect(record?.id).toBe("nightly");
    const messages = await reopened.listMessages("nightly");
    expect(record?.updatedAt).toBe(messages.at(-1)?.createdAt);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("compacts a session whose history outgrows a tiny window, in one write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const store = new JsonSessionStore(dir);
    bind(store);
    const chatty = agent({ prompt: "Talk." });
    const ask = step("ask")
      .input(text)
      .do(async ({ agents, input }) => {
        const session = await agents.session(chatty, {
          compaction: {
            keepTokens: 20,
            model: { contextWindow: 400, id: "opus", maxOutputTokens: 50 },
          },
          session: { id: "long" },
        });
        await session.generate(input.text);
        return null;
      });
    for (let i = 0; i < 12; i += 1) {
      await launch(ask, { text: `turn ${String(i)} ${"x".repeat(200)}` });
    }

    const all = await store.listMessages("long");
    const active = await store.activeMessages("long");
    expect(all.some((m) => m.role === "summary")).toBe(true);
    expect(active.length).toBeLessThan(all.length);
    expect(new JsonSessionStore(dir).sessions()).toHaveLength(1);
  });
});

describe("JsonSessionStore across instances", () => {
  const parts: SessionPart[] = [{ text: "hi", type: "text" }];

  it("does not lose messages two stores on one directory append", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    // Two hosts, one created before the session existed: the dashboard and a
    // scheduled roll share <state>/sessions.
    const dashboard = new JsonSessionStore(dir);
    const roll = new JsonSessionStore(dir);
    await roll.createSession({ id: "shared" });

    await expect(dashboard.getSession("shared")).resolves.toMatchObject({
      id: "shared",
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        (index % 2 === 0 ? dashboard : roll).appendMessage({
          parts: [{ text: `m${String(index)}`, type: "text" }],
          role: "user",
          sessionId: "shared",
        })
      )
    );
    await dashboard.appendMessage({ parts, role: "user", sessionId: "shared" });
    await roll.appendMessage({ parts, role: "assistant", sessionId: "shared" });

    const seen = await new JsonSessionStore(dir).listMessages("shared");
    expect(seen).toHaveLength(8);
    await expect(roll.listMessages("shared")).resolves.toEqual(seen);
  });

  it("updates a message another store appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const writer = new JsonSessionStore(dir);
    const other = new JsonSessionStore(dir);
    await writer.createSession({ id: "s" });
    const message = await writer.appendMessage({
      parts,
      role: "assistant",
      sessionId: "s",
      status: "streaming",
    });

    await expect(
      other.updateMessage(message.id, { status: "complete" })
    ).resolves.toMatchObject({ id: message.id, status: "complete" });
    await expect(writer.listMessages("s")).resolves.toMatchObject([
      { status: "complete" },
    ]);
    await expect(
      other.updateMessage("missing", { status: "complete" })
    ).resolves.toBeNull();
  });

  it("skips a corrupt session file with a warning instead of failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    await new JsonSessionStore(dir).createSession({ id: "good" });
    writeFileSync(join(dir, "broken.json"), "{not json");
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ session: {} }));
    const warnings: string[] = [];

    const store = new JsonSessionStore(dir, {
      warn: (line) => warnings.push(line),
    });
    expect(store.sessions().map((session) => session.id)).toEqual(["good"]);
    await expect(store.getSession("broken")).resolves.toBeNull();
    await expect(
      store.appendMessage({ parts, role: "user", sessionId: "wrong" })
    ).rejects.toThrow("unknown session");
    expect(warnings).toEqual(
      expect.arrayContaining([
        "[sessions] skipped broken.json: not JSON",
        "[sessions] skipped wrong.json: not a session file",
      ])
    );
  });
});

describe("sessionLines", () => {
  it("lists id, count, updated, and summary flag, newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const store = new JsonSessionStore(dir);
    const parts: SessionPart[] = [{ text: "hi", type: "text" }];

    vi.setSystemTime(new Date("2026-09-10T10:00:00.000Z"));
    await store.createSession({ id: "older" });
    await store.appendMessage({
      parts,
      role: "user",
      sessionId: "older",
    });
    const reply = await store.appendMessage({
      parts,
      role: "assistant",
      sessionId: "older",
    });
    await store.summarize({
      messageId: reply.id,
      sessionId: "older",
      summary: { parts },
    });

    vi.setSystemTime(new Date("2026-09-10T11:00:00.000Z"));
    await store.createSession({ id: "newer" });
    await store.appendMessage({
      parts,
      role: "user",
      sessionId: "newer",
    });

    expect(await sessionLines(store)).toEqual([
      "newer  1 messages  2026-09-10T11:00:00.000Z  summary: no",
      "older  3 messages  2026-09-10T10:00:00.000Z  summary: yes",
    ]);
  });
});
