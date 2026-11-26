import type { SessionPart } from "@foundry/agents/session";
import { Sessions } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";
import { agent, step } from "@foundry.sh/marbles";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { resourceLines } from "~/cli/resources/text";
import { ResourceView } from "~/database/resources";
import { DatabaseSessionStore } from "~/database/sessions";
import { CLAUDE_CODE } from "~/lib/harnesses";

import type { MockBindings } from "./helpers/bindings";
import { bindMock } from "./helpers/bindings";
import { durableSessions } from "./helpers/durable-sessions";
import { launch } from "./helpers/launch";
import { testMachine } from "./helpers/records";
import { temporaryDirectory } from "./helpers/temporary";

let mock: MockBindings | undefined;

afterEach(async () => {
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

describe("sessions kept in the Marbles database", () => {
  it("survives a new process: a fresh store over the same dir sees the turns", async () => {
    const dir = temporaryDirectory("marbles-sessions-");
    bind(durableSessions(dir));
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

    const reopened = durableSessions(dir);
    const [stamp] = await reopened.stamps();
    expect(stamp?.id).toBe("nightly");
    const record = await reopened.getSession("nightly");
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
    const dir = temporaryDirectory("marbles-sessions-");
    const store = durableSessions(dir);
    const sessions = new Sessions({ store });
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
    const active = await sessions.activeMessages("long");
    expect(all.some((m) => m.role === "summary")).toBe(true);
    expect(active.length).toBeLessThan(all.length);
    expect(await durableSessions(dir).stamps()).toHaveLength(1);
  });
});

describe("the sessions a workspace shows", () => {
  it("lists id, count, updated, and summary flag, newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const machine = await testMachine();
    onTestFinished(() => machine.close());
    const { database } = machine.database;
    const store = new DatabaseSessionStore({ database, scope: "ws" });
    const sessions = new Sessions({ store });
    const parts: SessionPart[] = [{ text: "hi", type: "text" }];

    vi.setSystemTime(new Date("2026-09-10T10:00:00.000Z"));
    await sessions.createSession({ id: "older" });
    await sessions.appendMessage({
      parts,
      role: "user",
      sessionId: "older",
    });
    const reply = await sessions.appendMessage({
      parts,
      role: "assistant",
      sessionId: "older",
    });
    await sessions.summarize({
      messageId: reply.id,
      sessionId: "older",
      summary: { parts },
    });

    vi.setSystemTime(new Date("2026-09-10T11:00:00.000Z"));
    await sessions.createSession({ id: "newer" });
    await sessions.appendMessage({
      parts,
      role: "user",
      sessionId: "newer",
    });

    const view = new ResourceView({
      database,
      scope: { workspace: "ws" },
      state: machine.root,
    });
    expect(await resourceLines("session", view, "ws")).toEqual([
      "newer  1 messages  2026-09-10T11:00:00.000Z  summary: no",
      "older  3 messages  2026-09-10T10:00:00.000Z  summary: yes",
    ]);
  });
});
