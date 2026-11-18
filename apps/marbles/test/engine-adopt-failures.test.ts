import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { step } from "~/authoring/index";
import { DatabaseExecutionStore } from "~/database/executions";
import { initializeDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import type { Engine } from "~/lib/engine";
import { testEngine } from "./helpers/engine";

const LISTING_FAILURE = "injected listing failure";
const RELEASE_FAILURE = "injected release failure";

const cleanups: (() => Promise<void> | void)[] = [];
let entered = Promise.withResolvers<void>();
let late = Promise.withResolvers<void>();

beforeEach(() => {
  entered = Promise.withResolvers<void>();
  late = Promise.withResolvers<void>();
});

afterEach(async () => {
  late.resolve();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

step("adopt-failures-ask").do(
  async ({ ask }) => await ask.question({ choices: ["yes"], title: "Ship?" })
);

step("adopt-failures-late-ask").do(async ({ ask }) => {
  entered.resolve();
  await late.promise;
  return await ask.question({ choices: ["yes"], title: "Ship late?" });
});

interface Faults {
  listing: boolean;
  rebuilding: boolean;
  rebuilt: boolean;
  readonly released: string[];
  releases: number;
}

interface Listing {
  readonly runId?: string;
  readonly status?: unknown;
}

function faultyStore<T extends object>(store: T, faults: Faults): T {
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "transaction") {
        return (work: (view: object) => Promise<unknown>) =>
          Reflect.apply(value, target, [
            (view: object) => work(faultyStore(view, faults)),
          ]);
      }
      if (property !== "listSuspensions") {
        return (...given: unknown[]) => Reflect.apply(value, target, given);
      }
      return (query?: Listing) => {
        if (faults.listing && query?.runId !== undefined) {
          if (query.status === undefined) {
            if (faults.rebuilding) {
              return Promise.reject(new Error(LISTING_FAILURE));
            }
            faults.rebuilt = true;
          } else if (faults.rebuilt) {
            return Promise.reject(new Error(LISTING_FAILURE));
          }
        }
        return Reflect.apply(value, target, [query]);
      };
    },
  });
}

async function home() {
  const directory = mkdtempSync(join(tmpdir(), "marbles-adopt-failures-"));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  const db = await initializeDatabase(join(directory, "marbles.db"));
  cleanups.push(() => db.close());

  const plain = async () => {
    const engine = testEngine({ askable: true, state: directory });
    cleanups.push(() => engine.dispose());
    await engine.start();
    return engine;
  };

  const faulty = async () => {
    const faults: Faults = {
      listing: false,
      rebuilding: false,
      rebuilt: false,
      released: [],
      releases: 0,
    };
    const runs = new DatabaseRunStore({ database: db.database, scope: "test" });
    const { open, release } = runs;
    runs.open = async (...given) =>
      faultyStore(await open.apply(runs, given), faults);
    runs.release = (runId) => {
      if (runId !== undefined) {
        faults.released.push(runId);
        if (faults.releases > 0) {
          faults.releases -= 1;
          return Promise.reject(new Error(RELEASE_FAILURE));
        }
      }
      return release.call(runs, runId);
    };
    const engine = testEngine({
      askable: true,
      executionStore: new DatabaseExecutionStore({
        database: db.database,
        scope: "test",
      }),
      runs,
      state: directory,
    });
    cleanups.push(() => engine.dispose());
    await engine.start();
    return { engine, faults };
  };

  return { faulty, plain };
}

async function statusOf(engine: Engine, runId: string) {
  return (await engine.runs()).find((each) => each.id === runId)?.status;
}

async function launchParked(engine: Engine) {
  const launched = await engine.launch("adopt-failures-ask", {});
  launched.result.catch(() => undefined);
  await vi.waitFor(async () =>
    expect(await statusOf(engine, launched.id)).toBe("suspended")
  );
  return launched.id;
}

async function openEntry(engine: Engine) {
  return await vi.waitFor(async () => {
    const open = (await engine.feed()).find(
      (each) => each.input?.status === "open"
    );
    expect(open).toBeDefined();
    return open?.id ?? "";
  });
}

async function answered(engine: Engine, runId: string) {
  await engine.answer(await openEntry(engine), "yes");
  await vi.waitFor(async () =>
    expect(await statusOf(engine, runId)).toBe("complete")
  );
}

async function pause(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("an adoption that fails after the orchestrator took the run on", () => {
  it("is rolled back whole, so the same engine takes the run over when it is offered again", async () => {
    const { faulty, plain } = await home();
    const first = await plain();
    const second = await faulty();
    const runId = await launchParked(first);
    await first.retire(thisProcess());

    second.faults.listing = true;
    await expect(second.engine.adopt(runId)).rejects.toThrow(LISTING_FAILURE);
    second.faults.listing = false;

    expect(await second.engine.adopt(runId)).toBe(true);
    await answered(second.engine, runId);
  }, 60_000);

  it("leaves nothing that blocks the next attempt when it fails before the orchestrator holds the run", async () => {
    const { faulty, plain } = await home();
    const first = await plain();
    const second = await faulty();
    const runId = await launchParked(first);
    await first.retire(thisProcess());

    second.faults.listing = true;
    second.faults.rebuilding = true;
    await expect(second.engine.adopt(runId)).rejects.toThrow(LISTING_FAILURE);
    second.faults.listing = false;

    expect(await second.engine.adopt(runId)).toBe(true);
    await answered(second.engine, runId);
  }, 60_000);

  it("keeps the claim it took again, whatever release it still owed from the adoption that failed", async () => {
    const { faulty, plain } = await home();
    const first = await plain();
    const second = await faulty();
    const third = await plain();
    const runId = await launchParked(first);
    await first.retire(thisProcess());

    second.faults.listing = true;
    second.faults.releases = 1;
    await expect(second.engine.adopt(runId)).rejects.toThrow(LISTING_FAILURE);
    second.faults.listing = false;
    expect(second.faults.released).toEqual([runId]);

    expect(await second.engine.adopt(runId)).toBe(true);
    await pause(1500);
    expect(second.faults.released).toEqual([runId]);
    expect(await third.adopt(runId)).toBe(false);
    await answered(second.engine, runId);
  }, 60_000);

  it("lets the run go once the release works, when the adoption and its first release both failed", async () => {
    const { faulty, plain } = await home();
    const first = await plain();
    const second = await faulty();
    const third = await plain();
    const runId = await launchParked(first);
    await first.retire(thisProcess());

    second.faults.listing = true;
    second.faults.releases = 1;
    await expect(second.engine.adopt(runId)).rejects.toThrow(LISTING_FAILURE);

    await vi.waitFor(async () => expect(await third.adopt(runId)).toBe(true), {
      interval: 100,
      timeout: 10_000,
    });
    expect(second.faults.released).toEqual([runId, runId]);
    await answered(third, runId);
  }, 60_000);
});

describe("a retired engine whose release of a parked run fails", () => {
  it("keeps trying to let go of a run that parked after it retired, answers nothing for it meanwhile, and says so once it is let go", async () => {
    const { faulty, plain } = await home();
    const old = await faulty();
    const next = await plain();
    const launched = await old.engine.launch("adopt-failures-late-ask", {});
    launched.result.catch(() => undefined);
    await entered.promise;
    const letGo: string[] = [];
    await old.engine.retire(thisProcess(), {
      onLetGo: (runId) => letGo.push(runId),
    });

    old.faults.releases = 2;
    late.resolve();
    await vi.waitFor(() => expect(old.faults.released).toEqual([launched.id]));
    const entry = await openEntry(old.engine);
    await expect(old.engine.answer(entry, "yes")).rejects.toThrow(
      expect.objectContaining({ name: "QuestionMovingError" })
    );
    expect(await next.adopt(launched.id)).toBe(false);
    expect(letGo).toEqual([]);

    await vi.waitFor(() => expect(letGo).toEqual([launched.id]), {
      timeout: 10_000,
    });
    expect(old.faults.released).toHaveLength(3);
    expect(await next.adopt(launched.id)).toBe(true);
    await answered(next, launched.id);
    await pause(100);
    expect(letGo).toEqual([launched.id]);
  }, 60_000);

  it("retires all the same and lets go of every run parked before it retired, the failed one once its release works", async () => {
    const { faulty, plain } = await home();
    const old = await faulty();
    const next = await plain();
    const one = await launchParked(old.engine);
    const two = await launchParked(old.engine);

    old.faults.releases = 1;
    await old.engine.retire(thisProcess());
    expect([...old.faults.released].sort()).toEqual([one, two].sort());

    for (const runId of [one, two]) {
      await vi.waitFor(async () => expect(await next.adopt(runId)).toBe(true), {
        interval: 100,
        timeout: 10_000,
      });
    }
    expect(old.faults.released).toHaveLength(3);
  }, 60_000);
});
