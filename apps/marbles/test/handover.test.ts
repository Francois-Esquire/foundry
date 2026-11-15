import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@foundry/lib/config";
import { thisProcess } from "@foundry/lib/process-identity";
import { ExecutionCoordinator } from "@foundry/workflows";
import { contributeQueueConfig } from "@foundry/workflows/config";
import { Orchestrator } from "@foundry/workflows/orchestrator";
import type { StepContext } from "@foundry/workflows/step";
import { Workflow } from "@foundry/workflows/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { step } from "~/authoring/index";
import { DatabaseExecutionStore } from "~/database/executions";
import { initializeDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { feedRouter } from "~/lib/feed/route";
import { testEngine } from "./helpers/engine";

/**
 * A parked run moving from one engine to another while something reaches
 * for it: an answer read before the move and applied after it, and an
 * adoption that finds its engine retiring when it completes. Each is
 * stopped at the step that would have trusted an earlier look, so the
 * race is the same every time.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Two Orchestrators over one store and one queue, each running `job`, which asks once. */
async function twoOrchestrators() {
  const store = new ExecutionCoordinator();
  const queue = `handover-${crypto.randomUUID()}`;
  const done: string[] = [];
  const make = async (label: string) => {
    const config = new Config();
    contributeQueueConfig(config, { concurrency: 1, defaultName: queue });
    const orchestrator = new Orchestrator({ config, store });
    await orchestrator.setup();
    orchestrator.register("job", (input: null) =>
      Workflow.create({
        execute: async (_value: null, run: StepContext<null>) => {
          const answer = await run.suspend({
            kind: "marbles.feed.input",
            name: "q",
            reason: "review",
            request: { choices: ["yes"], key: "q", title: "Ship?" },
          });
          done.push(label);
          return answer;
        },
        input,
        name: "job",
      })
    );
    await orchestrator.start();
    cleanups.push(() => orchestrator.stop());
    return orchestrator;
  };
  return { done, first: await make("OLD"), second: await make("NEW") };
}

async function parked(orchestrator: Orchestrator, runId: string) {
  return await vi.waitFor(async () => {
    const [pending] = (
      await orchestrator.listSuspensions({ runId, status: "pending" })
    ).items;
    expect(pending).toBeDefined();
    return pending;
  });
}

/**
 * A router over `orchestrator` whose read of the suspension waits until
 * `gate` opens, having said it began.
 */
function gatedRouter(orchestrator: Orchestrator) {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const router = feedRouter({
    askable: true,
    feed: { publishInput: () => Promise.resolve("entry") } as never,
    orchestrator: {
      getSuspension: async (id: string) => {
        const read = await orchestrator.getSuspension(id);
        entered.resolve();
        await gate.promise;
        return read;
      },
      listSuspensions: orchestrator.listSuspensions.bind(orchestrator),
      resolve: orchestrator.resolve.bind(orchestrator),
    } as never,
    print: () => undefined,
  });
  return { entered: entered.promise, open: gate.resolve, router };
}

function plainRouter(orchestrator: Orchestrator) {
  return feedRouter({
    askable: true,
    feed: { publishInput: () => Promise.resolve("entry") } as never,
    orchestrator,
    print: () => undefined,
  });
}

describe("an answer that meets a handover", () => {
  it("is refused by the engine that retired while it read the question, and applied once by the one that took the run", async () => {
    const { done, first, second } = await twoOrchestrators();
    const run = await first.run("job", null);
    await parked(first, run.id);
    const old = gatedRouter(first);
    await old.router.adopt("job", run.id);
    const answering = old.router.answer("entry", "yes");
    await old.entered;
    // Retired and taken over while the answer read the question.
    old.router.retire();
    old.router.letGo(run.id);
    const adopted = await second.adopt(run.id);
    old.open();
    await expect(answering).rejects.toThrow(
      expect.objectContaining({ name: "QuestionMovingError" })
    );
    const current = plainRouter(second);
    await current.adopt("job", run.id);
    await current.answer("entry", "yes");
    await adopted?.result();
    expect(done).toEqual(["NEW"]);
  });

  it("is refused as stale when another engine took the run over while it read, though nothing retired here", async () => {
    const { done, first, second } = await twoOrchestrators();
    const run = await first.run("job", null);
    await parked(first, run.id);
    const old = gatedRouter(first);
    await old.router.adopt("job", run.id);
    const answering = old.router.answer("entry", "yes");
    await old.entered;
    // Only the stored suspension says it moved: claimed at a new revision.
    const adopted = await second.adopt(run.id);
    old.open();
    await expect(answering).rejects.toThrow(
      expect.objectContaining({ name: "QuestionMovingError" })
    );
    const current = plainRouter(second);
    await current.adopt("job", run.id);
    await current.answer("entry", "yes");
    await adopted?.result();
    expect(done).toEqual(["NEW"]);
  });
});

step("handover-ask").do(
  async ({ ask }) => await ask.question({ choices: ["yes"], title: "Ship?" })
);

describe("an adoption that meets a retirement", () => {
  it("gives the run back when its engine began to retire while it took it over, and the next engine resumes it", async () => {
    const home = mkdtempSync(join(tmpdir(), "marbles-handover-"));
    cleanups.push(() => rmSync(home, { force: true, recursive: true }));
    const db = await initializeDatabase(join(home, "marbles.db"));
    cleanups.push(() => db.close());
    const runs = new DatabaseRunStore({ database: db.database, scope: "test" });
    const first = testEngine({ askable: true, state: home });
    const second = testEngine({
      askable: true,
      executionStore: new DatabaseExecutionStore({
        database: db.database,
        scope: "test",
      }),
      runs,
      state: home,
    });
    cleanups.push(() => first.dispose());
    cleanups.push(() => second.dispose());
    await first.start();
    await second.start();
    const launched = await first.launch("handover-ask", {});
    launched.result.catch(() => undefined);
    await vi.waitFor(async () =>
      expect(
        (await first.runs()).find((each) => each.id === launched.id)?.status
      ).toBe("suspended")
    );
    await first.retire(thisProcess());

    // The adoption waits in its read of what the run recorded.
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { recorded } = runs;
    runs.recorded = async (id) => {
      entered.resolve();
      await gate.promise;
      return await recorded.call(runs, id);
    };
    const adopting = second.adopt(launched.id);
    await entered.promise;
    await second.retire(thisProcess());
    gate.resolve();
    expect(await adopting).toBe(false);

    // Given back, unowned: the next engine takes it over and resumes it.
    const third = testEngine({ askable: true, state: home });
    cleanups.push(() => third.dispose());
    await third.start();
    const entry = await vi.waitFor(async () => {
      const open = (await third.feed()).find(
        (each) => each.input?.status === "open"
      );
      expect(open).toBeDefined();
      return open?.id ?? "";
    });
    await third.answer(entry, "yes");
    await vi.waitFor(async () =>
      expect(
        (await third.runs()).find((each) => each.id === launched.id)?.status
      ).toBe("complete")
    );
  });
});
