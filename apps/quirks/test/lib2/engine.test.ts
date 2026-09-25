/**
 * The new lib through the real engine: a named definition registered from
 * the catalog, an approval that parks the run as an open feed entry, the
 * dashboard's answer resuming it, reports landing as entries, and the run
 * scope closing when the run settles.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startEngine } from "~/engine";
import { openFeed } from "~/feed/store";
import { createLog } from "~/lib/log";
import { unbound } from "~/lib2/bindings";
import { step } from "~/lib2/builder";
import { catalog } from "~/lib2/catalog";
import { runs } from "~/lib2/run-scope";
import { registerCatalog } from "~/lib2/tree";
import type { FeedEntrySnapshot } from "~/views/dashboard-model";

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
      const { approved } = await ask.approval({
        body: "Ship v2?",
        title: "Release v2",
      });
      report.result({ body: approved ? "shipped" : "held", title: "Outcome" });
      return { approved, run: run.id };
    });
    const store = openFeed(undefined, { id: "ws", root });
    const engine = await startEngine(registerCatalog, {
      askable: true,
      feed: store.publisher,
      print: () => undefined,
    });

    const launched = await engine.launch<{ approved: boolean; run: string }>(
      "release",
      {}
    );
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

    await engine.answer(question.id, "approve");
    await expect(launched.result).resolves.toEqual({
      approved: true,
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
      status: "answered",
    });
    await engine.stop();
  });
});
