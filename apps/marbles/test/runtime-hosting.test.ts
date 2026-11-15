/**
 * Which engine a workspace's own code answers to (`authoring/runtime.ts`):
 * the engine its run, observer or load belongs to, until that engine is
 * disposed, whatever engine is bound to the workspace after it; then it
 * is refused. Never the engine bound after it.
 */

import { expect, it } from "vitest";
import { Catalog } from "~/authoring/catalog";
import type { InstanceRuntime, Scope } from "~/authoring/runtime";
import {
  captureScope,
  declaringCatalog,
  inLoad,
  instanceRuntime,
  loadInto,
  setHost,
} from "~/authoring/runtime";
import { inContext } from "~/lib/execution-context";

type TestEngine = InstanceRuntime & { disposed: boolean };

/** An engine as the slot sees it: its workspace, the context its runs execute in, and whether it was disposed. */
function engine(workspaceId: string): TestEngine {
  return {
    context: { cwd: "/", environment: {}, workspaceId },
    disposed: false,
    workspaceId,
  } as unknown as TestEngine;
}

/** Load `workspaceId` into `into`; resolves the load's number. */
async function load(workspaceId: string, into: Catalog): Promise<number> {
  let number = 0;
  await loadInto(workspaceId, into, (n) => {
    number = n;
    return Promise.resolve();
  });
  return number;
}

/** Run `work` as one of `owner`'s runs would: in its execution context. */
function inRunOf<T>(owner: TestEngine, work: () => T): T {
  return inContext(owner.context, work);
}

const RELEASED = expect.objectContaining({ name: "WorkspaceReleasedError" });

/** What `work` declares into and reaches, or the name of what it threw. */
async function reached(
  work: (call: () => unknown) => unknown
): Promise<{ catalog: unknown; runtime: unknown }> {
  const catalog = await Promise.resolve()
    .then(() => work(declaringCatalog))
    .catch((error: Error) => error.name);
  const runtime = await Promise.resolve()
    .then(() => work(instanceRuntime))
    .catch((error: Error) => error.name);
  return { catalog, runtime };
}

/** A workspace with a first engine bound, then a second bound while the first still runs. */
async function replaced(workspace: string) {
  const old = new Catalog();
  const first = await load(workspace, old);
  const oldEngine = engine(workspace);
  setHost(oldEngine, old);
  const next = new Catalog();
  const second = await load(workspace, next);
  const nextEngine = engine(workspace);
  return {
    bindNext: () => setHost(nextEngine, next),
    first,
    next,
    nextEngine,
    old,
    oldEngine,
    second,
  };
}

it("keeps an old engine's runs and loads on that engine after another is bound, until it is disposed", async () => {
  const w = await replaced("old-still-runs");
  w.bindNext();
  // The old engine still finishes the runs it has: they answer to it.
  expect(await reached((call) => inRunOf(w.oldEngine, call))).toEqual({
    catalog: w.old,
    runtime: w.oldEngine,
  });
  expect(await reached((call) => inLoad(w.first, call))).toEqual({
    catalog: w.old,
    runtime: w.oldEngine,
  });
  // The new engine's own work reaches it.
  expect(await reached((call) => inRunOf(w.nextEngine, call))).toEqual({
    catalog: w.next,
    runtime: w.nextEngine,
  });
  expect(await reached((call) => inLoad(w.second, call))).toEqual({
    catalog: w.next,
    runtime: w.nextEngine,
  });

  w.oldEngine.disposed = true;
  // Disposed: refused, never handed to the engine bound after it.
  expect(await reached((call) => inRunOf(w.oldEngine, call))).toEqual({
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  });
  expect(await reached((call) => inLoad(w.first, call))).toEqual({
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  });
  expect(await reached((call) => inLoad(w.second, call))).toEqual({
    catalog: w.next,
    runtime: w.nextEngine,
  });
});

it("refuses a continuation of an old run that resumes once its engine is disposed and replaced", async () => {
  const w = await replaced("continuation");
  const { promise: gate, resolve: open } = Promise.withResolvers<undefined>();
  const resumed = inRunOf(w.oldEngine, async () => {
    await gate;
    return await reached((call) => call());
  });
  w.bindNext();
  w.oldEngine.disposed = true;
  open(undefined);
  expect(await resumed).toEqual({
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  });
});

it("gives a scope an old run captures after another engine is bound the old engine, until it is disposed", async () => {
  const w = await replaced("late-capture");
  w.bindNext();
  const late: Scope = inRunOf(w.oldEngine, captureScope);
  expect(await reached((call) => late(call))).toEqual({
    catalog: w.old,
    runtime: w.oldEngine,
  });
  w.oldEngine.disposed = true;
  expect(await reached((call) => late(call))).toEqual({
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  });
});

it("gives a scope captured while a load ran the engine that took that load", async () => {
  const workspace = "load-capture";
  const old = new Catalog();
  let made: Scope | undefined;
  await loadInto(workspace, old, (n) => {
    made = inLoad(n, captureScope);
    return Promise.resolve();
  });
  const oldEngine = engine(workspace);
  setHost(oldEngine, old);
  const next = new Catalog();
  await load(workspace, next);
  setHost(engine(workspace), next);
  const scope = made as Scope;
  expect(await reached((call) => scope(call))).toEqual({
    catalog: old,
    runtime: oldEngine,
  });
  oldEngine.disposed = true;
  expect(() => scope(declaringCatalog)).toThrow(RELEASED);
});

it("keeps an old run's timers and promises on its engine while it lives, and refuses them once it is disposed", async () => {
  const w = await replaced("timers");
  const { promise: firstGate, resolve: openFirst } =
    Promise.withResolvers<undefined>();
  const { promise: secondGate, resolve: openSecond } =
    Promise.withResolvers<undefined>();
  const { promise: firstTimer, resolve: fireFirst } =
    Promise.withResolvers<undefined>();
  const { promise: secondTimer, resolve: fireSecond } =
    Promise.withResolvers<undefined>();
  // Set up inside the old run: each runs later, as a timer or promise of
  // that run would.
  const outcomes = inRunOf(w.oldEngine, () => {
    const timed = (fire: Promise<undefined>) =>
      new Promise<{ catalog: unknown; runtime: unknown }>((settle) => {
        fire.then(
          () =>
            setTimeout(() => {
              settle(reached((call) => call()));
            }, 1),
          () => undefined
        );
      });
    return {
      firstPromise: firstGate.then(() => reached((call) => call())),
      firstTimer: timed(firstTimer),
      secondPromise: secondGate.then(() => reached((call) => call())),
      secondTimer: timed(secondTimer),
    };
  });
  w.bindNext();
  // After the replacement, before the old engine is disposed.
  openFirst(undefined);
  fireFirst(undefined);
  const alive = { catalog: w.old, runtime: w.oldEngine };
  expect(await outcomes.firstPromise).toEqual(alive);
  expect(await outcomes.firstTimer).toEqual(alive);
  // Once it is disposed.
  w.oldEngine.disposed = true;
  openSecond(undefined);
  fireSecond(undefined);
  const refused = {
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  };
  expect(await outcomes.secondPromise).toEqual(refused);
  expect(await outcomes.secondTimer).toEqual(refused);
});

it("refuses a first load's late work once its engine closed, though the workspace is hosted again", async () => {
  const workspace = "hosted-again";
  const old = new Catalog();
  const first = await load(workspace, old);
  const firstEngine = engine(workspace);
  setHost(firstEngine, old);
  firstEngine.disposed = true;
  expect(() => inLoad(first, declaringCatalog)).toThrow(RELEASED);

  const next = new Catalog();
  const second = await load(workspace, next);
  const secondEngine = engine(workspace);
  setHost(secondEngine, next);
  expect(() => inLoad(first, declaringCatalog)).toThrow(RELEASED);
  await expect(inLoad(first, instanceRuntime)).rejects.toThrow(RELEASED);
  expect(inLoad(second, declaringCatalog)).toBe(next);
  expect(await inLoad(second, instanceRuntime)).toBe(secondEngine);
});
