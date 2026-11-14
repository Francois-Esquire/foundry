import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPart } from "@foundry/agents/session";
import { Sessions } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";
import { processAlive } from "@foundry/lib/file-lock";
import { agent, step } from "@foundry.sh/marbles";
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
    expect(new JsonSessionStore(dir).sessions()).toHaveLength(1);
  });
});

describe("JsonSessionStore session ids", () => {
  it("refuses an id that is not a single file name, writing nothing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const dir = join(parent, "sessions");
    const store = new JsonSessionStore(dir);
    const sessions = new Sessions({ store });

    for (const id of ["../outside", "nested/inner", "back\\slash", "nul\0"]) {
      await expect(sessions.createSession({ id })).rejects.toThrow(
        "cannot name a file"
      );
    }
    expect(readdirSync(parent)).toEqual(["sessions"]);
    expect(readdirSync(dir)).toEqual([]);

    await sessions.createSession({ id: "..dots.." });
    expect(store.sessions().map((record) => record.id)).toEqual(["..dots.."]);
  });

  it("lists past a stray file whose name no session id could make", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const store = new JsonSessionStore(dir);
    const sessions = new Sessions({ store });
    await sessions.createSession({ id: "valid" });
    const message = await sessions.appendMessage({
      parts: [{ text: "hi", type: "text" }],
      role: "user",
      sessionId: "valid",
    });
    writeFileSync(join(dir, "back\\slash.json"), "{}");

    expect(store.sessions().map((record) => record.id)).toEqual(["valid"]);
    await expect(
      sessions.updateMessage("missing", { status: "complete" })
    ).resolves.toBeNull();
    await expect(
      sessions.updateMessage(message.id, { status: "complete" })
    ).resolves.toMatchObject({ id: message.id, status: "complete" });
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
    await new Sessions({ store: roll }).createSession({ id: "shared" });

    await expect(dashboard.getSession("shared")).resolves.toMatchObject({
      id: "shared",
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        new Sessions({
          store: index % 2 === 0 ? dashboard : roll,
        }).appendMessage({
          parts: [{ text: `m${String(index)}`, type: "text" }],
          role: "user",
          sessionId: "shared",
        })
      )
    );
    await new Sessions({ store: dashboard }).appendMessage({
      parts,
      role: "user",
      sessionId: "shared",
    });
    await new Sessions({ store: roll }).appendMessage({
      parts,
      role: "assistant",
      sessionId: "shared",
    });

    const seen = await new JsonSessionStore(dir).listMessages("shared");
    expect(seen).toHaveLength(8);
    await expect(roll.listMessages("shared")).resolves.toEqual(seen);
  });

  it("keeps both of two overlapping updates two stores make", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const dashboard = new Sessions({ store: new JsonSessionStore(dir) });
    const roll = new Sessions({ store: new JsonSessionStore(dir) });
    await dashboard.createSession({ id: "s" });

    await Promise.all([
      dashboard.updateSession("s", { title: "renamed" }),
      roll.updateSession("s", { status: "archived" }),
    ]);

    await expect(
      new JsonSessionStore(dir).getSession("s")
    ).resolves.toMatchObject({ status: "archived", title: "renamed" });
  });

  it("updates a message another store appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const writer = new JsonSessionStore(dir);
    const other = new JsonSessionStore(dir);
    await new Sessions({ store: writer }).createSession({ id: "s" });
    const message = await new Sessions({ store: writer }).appendMessage({
      parts,
      role: "assistant",
      sessionId: "s",
      status: "streaming",
    });

    await expect(
      new Sessions({ store: other }).updateMessage(message.id, {
        status: "complete",
      })
    ).resolves.toMatchObject({ id: message.id, status: "complete" });
    await expect(writer.listMessages("s")).resolves.toMatchObject([
      { status: "complete" },
    ]);
    await expect(
      new Sessions({ store: other }).updateMessage("missing", {
        status: "complete",
      })
    ).resolves.toBeNull();
  });

  it("skips a corrupt session file with a warning instead of failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    await new Sessions({ store: new JsonSessionStore(dir) }).createSession({
      id: "good",
    });
    writeFileSync(join(dir, "broken.json"), "{not json");
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ session: {} }));
    const warnings: string[] = [];

    const store = new JsonSessionStore(dir, {
      warn: (line) => warnings.push(line),
    });
    const sessions = new Sessions({ store });
    expect(store.sessions().map((session) => session.id)).toEqual(["good"]);
    await expect(store.getSession("broken")).resolves.toBeNull();
    // An unreadable file reads as no session, so the append is refused before
    // any write reaches it.
    await expect(
      sessions.appendMessage({ parts, role: "user", sessionId: "wrong" })
    ).rejects.toThrow("unknown session: wrong");
    expect(readFileSync(join(dir, "wrong.json"), "utf8")).toBe(
      JSON.stringify({ session: {} })
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        "[sessions] skipped broken.json: not JSON",
        "[sessions] skipped wrong.json: not a session file",
      ])
    );
  });

  it("never replaces an unreadable file with a fresh session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const path = join(dir, "nightly.json");
    writeFileSync(path, "{damaged");
    const store = new JsonSessionStore(dir);
    const sessions = new Sessions({ store });

    // The harness creates a session it cannot find; here that must fail loudly.
    await expect(store.getSession("nightly")).resolves.toBeNull();
    await expect(sessions.createSession({ id: "nightly" })).rejects.toThrow(
      "repair or remove it"
    );
    expect(readFileSync(path, "utf8")).toBe("{damaged");
  });

  it("resumes, not resets, a session two stores both found missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const first = new JsonSessionStore(dir);
    const second = new JsonSessionStore(dir);
    const created = await new Sessions({ store: first }).createSession({
      id: "s",
      title: "first",
    });
    await new Sessions({ store: first }).appendMessage({
      parts,
      role: "user",
      sessionId: "s",
    });

    await expect(
      new Sessions({ store: second }).createSession({
        id: "s",
        title: "second",
      })
    ).resolves.toMatchObject({
      createdAt: created.createdAt,
      id: "s",
      title: "first",
    });
    await expect(second.listMessages("s")).resolves.toHaveLength(1);
  });

  it("builds on what another process wrote to the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const path = join(dir, "s.json");
    const store = new JsonSessionStore(dir);
    const sessions = new Sessions({ store });
    const message = (id: string, createdAt: number) => ({
      createdAt,
      id,
      parts,
      role: "user",
      sessionId: "s",
      status: "complete",
      updatedAt: createdAt,
    });
    // Another process, with nothing in common but the file.
    writeFileSync(
      path,
      JSON.stringify({
        messages: [message("outside-1", 1)],
        session: {
          createdAt: 1,
          id: "s",
          status: "active",
          title: null,
          updatedAt: 1,
        },
      })
    );

    const mine = await sessions.appendMessage({
      parts,
      role: "assistant",
      sessionId: "s",
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.messages.push(message("outside-2", 3));
    writeFileSync(path, JSON.stringify(saved));
    await sessions.updateMessage("outside-2", { status: "error" });

    const ids = (await store.listMessages("s")).map((m) => m.id);
    expect(ids).toEqual(["outside-1", mine.id, "outside-2"]);
    await expect(store.listMessages("s")).resolves.toMatchObject([
      {},
      {},
      { status: "error" },
    ]);
  });

  it("writes nothing to disk when a transaction's work throws, however much it committed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const store = new JsonSessionStore(dir);
    const sessions = new Sessions({ store });
    await sessions.createSession({ id: "a" });
    await sessions.appendMessage({ parts, role: "user", sessionId: "a" });
    await sessions.createSession({ id: "b" });
    const disk = () =>
      readdirSync(dir)
        .sort()
        .map((name) => [name, readFileSync(join(dir, name), "utf8")]);
    const before = disk();

    await expect(
      store.transaction(async (view) => {
        const a = await view.getSession("a");
        const [kept] = await view.listMessages("a");
        if (!(a && kept)) {
          throw new Error("seeded sessions missing");
        }
        await view.commit({
          putMessages: [{ ...kept, summarized: true }],
          putSessions: [{ ...a, title: "changed" }],
        });
        await view.commit({
          putMessages: [{ ...kept, id: "new", sessionId: "b" }],
        });
        await view.commit({ putSessions: [{ ...a, id: "c" }] });
        throw new Error("work failed");
      })
    ).rejects.toThrow("work failed");

    expect(disk()).toEqual(before);
  });

  it("holds the directory lock for a transaction that touches nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const store = new JsonSessionStore(dir);

    const held = await store.transaction(() =>
      Promise.resolve(existsSync(join(dir, ".lock")))
    );

    expect(held).toBe(true);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  });

  it("takes over the directory lock left by a process that exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const store = new JsonSessionStore(dir);
    const sessions = new Sessions({ store });
    await sessions.createSession({ id: "s" });
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    expect(pid !== undefined && processAlive(pid)).toBe(false);
    writeFileSync(join(dir, ".lock"), String(pid));

    await sessions.appendMessage({ parts, role: "user", sessionId: "s" });
    await expect(store.listMessages("s")).resolves.toHaveLength(1);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
    // The lock is not a session file.
    expect(store.sessions().map((record) => record.id)).toEqual(["s"]);
  });
});

describe("sessionLines", () => {
  it("lists id, count, updated, and summary flag, newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dir = mkdtempSync(join(tmpdir(), "marbles-sessions-"));
    const store = new JsonSessionStore(dir);
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

    expect(await sessionLines(store)).toEqual([
      "newer  1 messages  2026-09-10T11:00:00.000Z  summary: no",
      "older  3 messages  2026-09-10T10:00:00.000Z  summary: yes",
    ]);
  });
});
