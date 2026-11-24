import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { makeMemoryQueueStore } from "@foundry/queue/store/memory";
import type { StepContext } from "@foundry/workflows/step";
import { Workflow } from "@foundry/workflows/workflow";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { step } from "~/authoring/index";
import { DatabaseExecutionStore } from "~/database/executions";
import { initializeDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { feedRouter } from "~/lib/feed/route";
import { WorkflowQueue } from "~/lib/workflow-queue";
import { testEngine } from "./helpers/engine";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function twoQueues() {
  const store = Effect.runSync(makeMemoryQueueStore);
  const done: string[] = [];
  const make = (label: string) => {
    const queue = new WorkflowQueue(store);
    queue.register("job", (input) =>
      Workflow.create({
        execute: async (_value: unknown, run: StepContext<unknown>) => {
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
    cleanups.push(() => queue.stop());
    return queue;
  };
  return { done, first: make("OLD"), second: make("NEW") };
}

async function suspended(queue: WorkflowQueue, runId: string) {
  return await vi.waitFor(async () => {
    const [pending] = await queue.suspensions({ runId });
    expect(pending).toBeDefined();
    return pending;
  });
}

const launch = (queue: WorkflowQueue) =>
  queue.run("job", null, { runId: `rn-${crypto.randomUUID()}` });

function gatedRouter(queue: WorkflowQueue) {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const router = feedRouter({
    askable: true,
    feed: { publishInput: () => Promise.resolve("entry") } as never,
    print: () => undefined,
    queue: {
      cancelRun: (runId) => queue.cancelRun(runId),
      on: (signal, listener) => queue.on(signal, listener),
      resolve: (id, value, options) => queue.resolve(id, value, options),
      suspension: async (id) => {
        const read = await queue.suspension(id);
        entered.resolve();
        await gate.promise;
        return read;
      },
      suspensions: (query) => queue.suspensions(query),
    },
  });
  return { entered: entered.promise, open: gate.resolve, router };
}

function plainRouter(queue: WorkflowQueue) {
  return feedRouter({
    askable: true,
    feed: { publishInput: () => Promise.resolve("entry") } as never,
    print: () => undefined,
    queue,
  });
}

describe("an answer that meets a handover", () => {
  it("is refused by the engine that retired while it read the question, and applied once by the one that took the run", async () => {
    const { done, first, second } = twoQueues();
    const run = await launch(first);
    await suspended(first, run.id);
    const old = gatedRouter(first);
    await old.router.adopt("job", run.id);
    const answering = old.router.answer("entry", "yes");
    await old.entered;
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
    const { done, first, second } = twoQueues();
    const run = await launch(first);
    await suspended(first, run.id);
    const old = gatedRouter(first);
    await old.router.adopt("job", run.id);
    const answering = old.router.answer("entry", "yes");
    await old.entered;
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
