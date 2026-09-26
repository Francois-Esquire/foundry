/**
 * The new lib through the real engine: a named definition registered from
 * the catalog, an approval that parks the run as an open feed entry, the
 * dashboard's answer resuming it, reports landing as entries, and the run
 * scope closing when the run settles.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore } from "@foundry/agents/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startEngine } from "~/engine";
import { openFeed } from "~/feed/store";
import { unbound } from "~/lib/bindings";
import { step } from "~/lib/builder";
import { catalog } from "~/lib/catalog";
import { createLog } from "~/lib/log";
import { agent } from "~/lib/resources";
import { runs } from "~/lib/run-scope";
import { registerCatalog } from "~/lib/tree";
import type { FeedEntrySnapshot } from "~/views/dashboard-model";

import { bindMock } from "../helpers/bindings";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quirks-lib2-engine-"));
  catalog.bind({
    agents: () => unbound("agents"),
    artifacts: () => unbound("artifacts"),
    log: createLog(() => undefined),
    root,
    sandboxes: () => unbound("sandboxes"),
    workspaces: () => unbound("workspaces"),
  });
});

afterEach(async () => {
  catalog.reset();
  runs.clear();
  await rm(root, { force: true, recursive: true });
});

async function openEntry(
  read: () => Promise<FeedEntrySnapshot[]>,
  predicate: (entry: FeedEntrySnapshot) => boolean
) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const entry = (await read()).find(predicate);
    if (entry || Date.now() > deadline) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("lib2 through the engine", () => {
  it("parks on an approval, resumes on the answer, and settles the run scope", async () => {
    step("release").do(async ({ ask, report, run }) => {
      report.milestone({ title: "Ready to release" });
      const { approved, note } = await ask.approval({
        body: "Ship v2?",
        title: "Release v2",
      });
      report.result({ body: approved ? "shipped" : "held", title: "Outcome" });
      return { approved, note, run: run.id };
    });
    const store = openFeed(undefined, { id: "ws", root });
    const engine = await startEngine(registerCatalog, {
      askable: true,
      feed: store.publisher,
      print: () => undefined,
    });

    const launched = await engine.launch<{
      approved: boolean;
      note?: string;
      run: string;
    }>("release", {});
    const question = await openEntry(
      store.read,
      (entry) => entry.input?.status === "open"
    );
    expect(question).toMatchObject({
      input: {
        choices: ["approve", "reject"],
        mode: "approval",
        status: "open",
      },
      kind: "input",
      run: launched.id,
      step: "release",
      title: "Release v2",
    });
    expect(runs.has(launched.id)).toBe(true);
    if (!question) {
      throw new Error("expected an open approval");
    }

    await engine.answer(question.id, {
      choice: "approve",
      note: "after the docs land",
    });
    await expect(launched.result).resolves.toEqual({
      approved: true,
      note: "after the docs land",
      run: launched.id,
    });
    expect(runs.has(launched.id)).toBe(false);

    const entries = await store.read();
    expect(entries.map((entry) => [entry.kind, entry.title]).sort()).toEqual([
      ["input", "Release v2"],
      ["milestone", "Ready to release"],
      ["result", "Outcome"],
    ]);
    expect(entries.find((entry) => entry.kind === "input")?.input).toEqual({
      answer: "approve",
      choices: ["approve", "reject"],
      mode: "approval",
      note: "after the docs land",
      status: "answered",
    });
    await engine.stop();
  });

  it("a run parked on an approval survives a restart and replays with its ledger", async () => {
    const state = join(root, "state");
    const feedRoot = join(root, "feed");
    const sessions = new InMemorySessionStore();
    const reviewer = agent({ prompt: "Review." });
    const bodies: number[] = [];
    const define = () =>
      step("release").do(async ({ agents, ask, report, run }) => {
        bodies.push(run.session.id.length);
        const session = await agents.session(reviewer);
        const { approved } = await ask.approval({ title: "Release v2" });
        report.result({
          body: JSON.stringify({
            approved,
            runSession: run.session.id,
            session: session.ref.id,
          }),
          title: "Outcome",
        });
        return approved;
      });

    // Process one: park, then quit without cancelling the question.
    define();
    const first = bindMock(() => "ok", { root, sessions });
    const feedOne = openFeed(feedRoot, { id: "ws", root });
    const one = await startEngine(registerCatalog, {
      askable: true,
      feed: feedOne.publisher,
      print: () => undefined,
      state,
    });
    const launched = await one.launch<boolean>("release", {});
    launched.result.catch(() => undefined);
    const question = await openEntry(
      feedOne.read,
      (entry) => entry.input?.status === "open"
    );
    if (!question) {
      throw new Error("expected an open approval");
    }
    const scope = runs.get(launched.id);
    const recordedSession = scope?.ledger.toJSON();
    const runSession = scope?.session.id;
    expect(Object.keys(recordedSession ?? {})).toHaveLength(1);
    // Written when it parked, not only at stop: a crash leaves the file too.
    const parked = await openEntry(
      async () =>
        (existsSync(join(state, "runs"))
          ? readdirSync(join(state, "runs")).map((name) => ({
              status: (
                JSON.parse(readFileSync(join(state, "runs", name), "utf8")) as {
                  run: { status: string };
                }
              ).run.status,
            }))
          : []) as never,
      (entry) => (entry as unknown as { status: string }).status === "suspended"
    );
    expect(parked).toBeDefined();
    await one.stop();
    await first.dispose();
    const [file] = readdirSync(join(state, "runs"));
    const saved = JSON.parse(
      readFileSync(join(state, "runs", file as string), "utf8")
    ) as {
      quirks: { ledger: unknown; session: { id: string } };
      run: { status: string };
    };
    expect(saved.run.status).toBe("suspended");
    expect(saved.quirks).toEqual({
      ledger: recordedSession,
      session: { id: runSession },
    });
    expect((await feedOne.read())[0]?.input?.status).toBe("open");

    // Process two: adopt the parked run, answer, and finish it.
    catalog.reset();
    runs.clear();
    define();
    const second = bindMock(() => "ok", { root, sessions });
    const feedTwo = openFeed(feedRoot, { id: "ws", root });
    const lines: string[] = [];
    const two = await startEngine(registerCatalog, {
      askable: true,
      feed: feedTwo.publisher,
      print: (line) => lines.push(line),
      state,
    });
    expect(lines).toContain(`[run] release recovered ${launched.id}`);
    const stillOpen = (await feedTwo.read()).find(
      (entry) => entry.id === question.id
    );
    expect(stillOpen?.input?.status).toBe("open");
    await two.answer(question.id, "approve");
    const outcome = await openEntry(
      feedTwo.read,
      (entry) => entry.title === "Outcome"
    );
    expect(JSON.parse(outcome?.body.split("\n").at(-2) ?? "{}")).toEqual({
      approved: true,
      runSession,
      session: Object.values(recordedSession ?? {}).map(
        (ref) => (ref as { id: string }).id
      )[0],
    });
    const done = await openEntry(
      async () =>
        (await two.runs()).map((run) => ({ status: run.status })) as never,
      (entry) => (entry as unknown as { status: string }).status === "complete"
    );
    expect(done).toBeDefined();
    // The body ran once per process; the ledger gave the second run the
    // session the first opened instead of a new one.
    expect(bodies).toHaveLength(2);
    expect(runs.has(launched.id)).toBe(false);
    expect(existsSync(join(state, "runs", file as string))).toBe(true);
    await two.stop();
    await second.dispose();
  });

  it("leaves a parked run alone when this process cannot answer or the step is gone", async () => {
    const state = join(root, "state");
    const feedRoot = join(root, "feed");
    step("release").do(
      async ({ ask }) => (await ask.approval({ title: "Go?" })).approved
    );
    const feedOne = openFeed(feedRoot, { id: "ws", root });
    const one = await startEngine(registerCatalog, {
      askable: true,
      feed: feedOne.publisher,
      print: () => undefined,
      state,
    });
    const launched = await one.launch<boolean>("release", {});
    launched.result.catch(() => undefined);
    await openEntry(feedOne.read, (entry) => entry.input?.status === "open");
    await one.stop();

    // Not askable: the run is skipped, not adopted, and not cancelled.
    catalog.reset();
    runs.clear();
    step("release").do(
      async ({ ask }) => (await ask.approval({ title: "Go?" })).approved
    );
    const lines: string[] = [];
    const quiet = await startEngine(registerCatalog, {
      feed: openFeed(feedRoot, { id: "ws", root }).publisher,
      print: (line) => lines.push(line),
      state,
    });
    expect((await quiet.runs()).map((run) => run.id)).not.toContain(
      launched.id
    );
    expect(lines.join("\n")).toContain("nothing here can resume it");
    await quiet.stop();

    // Askable, but the step was renamed: skipped with a warning, no crash.
    catalog.reset();
    runs.clear();
    step("ship").do(
      async ({ ask }) => (await ask.approval({ title: "Go?" })).approved
    );
    const renamed: string[] = [];
    const later = await startEngine(registerCatalog, {
      askable: true,
      feed: openFeed(feedRoot, { id: "ws", root }).publisher,
      print: (line) => renamed.push(line),
      state,
    });
    expect((await later.runs()).map((run) => run.id)).not.toContain(
      launched.id
    );
    expect(renamed.join("\n")).toContain("nothing here can resume it");
    await later.stop();
  });
});
