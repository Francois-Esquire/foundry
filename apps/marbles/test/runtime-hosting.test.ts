/**
 * Which engine a workspace's own code answers to (`authoring/runtime.ts`):
 * the one bound to the load it came from, or to the run that made it,
 * never a later engine hosting the same workspace again.
 */

import { expect, it } from "vitest";
import { Catalog } from "~/authoring/catalog";
import type { InstanceRuntime } from "~/authoring/runtime";
import {
  captureScope,
  declaringCatalog,
  inLoad,
  instanceRuntime,
  loadInto,
  setHost,
} from "~/authoring/runtime";
import { inContext } from "~/lib/execution-context";

/** An engine as the slot sees it: its workspace, and whether it was disposed. */
function engine(workspaceId: string): InstanceRuntime & { disposed: boolean } {
  return { disposed: false, workspaceId } as InstanceRuntime & {
    disposed: boolean;
  };
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

it("refuses a first load's late work once its engine closed, though the workspace is hosted again", async () => {
  const workspace = "hosted-again";
  const old = new Catalog();
  const first = await load(workspace, old);
  const firstEngine = engine(workspace);
  setHost(firstEngine, old);
  expect(inLoad(first, declaringCatalog)).toBe(old);
  firstEngine.disposed = true;
  expect(() => inLoad(first, declaringCatalog)).toThrow(
    expect.objectContaining({ name: "WorkspaceReleasedError" })
  );

  const next = new Catalog();
  const second = await load(workspace, next);
  const secondEngine = engine(workspace);
  setHost(secondEngine, next);
  // The first load answered to the engine that closed, not to this one.
  expect(() => inLoad(first, declaringCatalog)).toThrow(
    expect.objectContaining({ name: "WorkspaceReleasedError" })
  );
  await expect(inLoad(first, instanceRuntime)).rejects.toThrow(
    expect.objectContaining({ name: "WorkspaceReleasedError" })
  );
  // The second load's own work reaches its own engine.
  expect(inLoad(second, declaringCatalog)).toBe(next);
  expect(await inLoad(second, instanceRuntime)).toBe(secondEngine);
});

it("lets a reload declare while the engine before it still runs, then refuses the old load once that engine is replaced", async () => {
  const workspace = "reloaded";
  const old = new Catalog();
  const first = await load(workspace, old);
  const firstEngine = engine(workspace);
  setHost(firstEngine, old);
  const next = new Catalog();
  const second = await load(workspace, next);
  // Both loads are open while the first engine still answers.
  expect(inLoad(first, declaringCatalog)).toBe(old);
  expect(inLoad(second, declaringCatalog)).toBe(next);
  expect(await inLoad(first, instanceRuntime)).toBe(firstEngine);

  const secondEngine = engine(workspace);
  setHost(secondEngine, next);
  firstEngine.disposed = true;
  expect(() => inLoad(first, declaringCatalog)).toThrow(
    expect.objectContaining({ name: "WorkspaceReleasedError" })
  );
  expect(inLoad(second, declaringCatalog)).toBe(next);
  expect(await inLoad(second, instanceRuntime)).toBe(secondEngine);
});

it("refuses what a closed engine's run left behind, rather than give it to the engine hosting the workspace again", async () => {
  const workspace = "run-left-behind";
  const old = new Catalog();
  await load(workspace, old);
  const firstEngine = engine(workspace);
  setHost(firstEngine, old);
  // Made in one of the first engine's runs, used after it closed.
  const scope = inContext(
    { cwd: "/", environment: {}, workspaceId: workspace },
    captureScope
  );
  firstEngine.disposed = true;
  const next = new Catalog();
  await load(workspace, next);
  setHost(engine(workspace), next);
  expect(() => scope(declaringCatalog)).toThrow(
    expect.objectContaining({ name: "WorkspaceReleasedError" })
  );
  await expect(scope(instanceRuntime)).rejects.toThrow(
    expect.objectContaining({ name: "WorkspaceReleasedError" })
  );
});
