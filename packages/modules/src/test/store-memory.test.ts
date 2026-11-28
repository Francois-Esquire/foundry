import type { ArtifactId, ContentId } from "@foundry/artifacts";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { InstallationId, ModuleId } from "../domain";
import type { Module, StoredInstallation } from "../records";
import { MemoryModuleStore } from "../store/memory";

const POISON = "poison" as InstallationId;

function module(id: string): Module {
  return { artifactId: `artifact-${id}` as ArtifactId, id: id as ModuleId };
}

function installation(id: InstallationId, owner: Module): StoredInstallation {
  return {
    installation: {
      containerId: null,
      contentId: "content" as ContentId,
      createdAt: new Date(0),
      generation: 0,
      id,
      moduleId: owner.id,
      startAttempts: 0,
      status: "disabled",
      updatedAt: new Date(0),
    },
  };
}

function failFilingPoison() {
  const { set } = Map.prototype;
  vi.spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ) {
    if (key === POISON) {
      throw new Error("filing failed");
    }
    return set.call(this, key, value);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MemoryModuleStore", () => {
  test("a write that fails part-way through applying leaves nothing", async () => {
    const store = new MemoryModuleStore();
    const kept = module("kept");
    await store.commit({ putModules: [kept] });
    const owner = module("partial");

    failFilingPoison();
    await expect(
      store.commit({
        deleteModules: [kept.id],
        putInstallations: [installation(POISON, owner)],
        putModules: [owner],
      })
    ).rejects.toThrow("filing failed");
    vi.restoreAllMocks();

    expect(await store.getModule(owner.id)).toBeNull();
    expect(await store.getModule(kept.id)).toEqual(kept);
    expect((await store.listModules({ limit: 10 })).items).toEqual([kept]);
  });

  test("a transaction's commit that fails part-way leaves nothing in the view, though the work goes on", async () => {
    const store = new MemoryModuleStore();
    const owner = module("partial");

    await store.transaction(async (view) => {
      failFilingPoison();
      await expect(
        view.commit({
          putInstallations: [installation(POISON, owner)],
          putModules: [owner],
        })
      ).rejects.toThrow("filing failed");
      vi.restoreAllMocks();
      expect(await view.getModule(owner.id)).toBeNull();
      await view.commit({ putModules: [module("after")] });
    });

    expect(
      (await store.listModules({ limit: 10 })).items.map(({ id }) => id)
    ).toEqual(["after"]);
  });
});
