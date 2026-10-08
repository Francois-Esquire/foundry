import { ArtifactTransaction } from "@foundry/artifacts/transaction";
import { describe, expect, it, vi } from "vitest";

import { defineModule, installationIdSchema, moduleIdSchema } from "../domain";
import { createModuleGateway } from "../gateway/module-gateway";
import { createModuleManagement } from "../management";
import { createModuleProgramSupervisor } from "../platform/program-supervisor";
import { ModuleStoreConflictError } from "../store/contract";
import { InMemoryModuleStore } from "../store/memory";
import { createModuleVersions } from "../version";
import {
  moduleFixture,
  PROGRAM_FILES,
  VALID_MANIFEST,
} from "./helpers/module-fixture";

async function fixture() {
  const {
    system: artifacts,
    artifact,
    content,
  } = await moduleFixture({
    files: {
      ...PROGRAM_FILES,
      "source/foundry.module.json": {
        bytes: JSON.stringify({
          ...VALID_MANIFEST,
          views: { home: { path: "/", title: "Home" } },
        }),
      },
    },
  });
  const store = new InMemoryModuleStore();
  const module = defineModule({ artifact, id: moduleIdSchema.parse("notes") });
  await store.registerModule({ module });
  const versions = createModuleVersions({ artifacts, store });
  const files = {
    backup: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    discardBackup: vi.fn(() => Promise.resolve()),
    prepare: vi.fn(
      ({
        installationId,
      }: {
        installationId: ReturnType<typeof installationIdSchema.parse>;
      }) => Promise.resolve({ hostPath: "/files", installationId })
    ),
    release: vi.fn(() => Promise.resolve()),
    restoreBackup: vi.fn(() => Promise.resolve(false)),
  };
  const programs = createModuleProgramSupervisor({
    files,
    gateway: createModuleGateway({ store }),
    removeContainer: () => Promise.resolve(),
    runtime: { start: () => Promise.reject(new Error("No runtime required")) },
    stopRetainedContainer: () => Promise.resolve(),
    store,
    versions,
  });
  let sequence = 0;
  const management = createModuleManagement({
    artifacts,
    createInstallationId: () => {
      sequence += 1;
      return installationIdSchema.parse(`installation-${sequence}`);
    },
    programs,
    store,
  });
  const installation = await management.createInstallation({
    contentId: content.id,
    moduleId: module.id,
  });
  return {
    artifacts,
    content,
    files,
    installation,
    management,
    module,
    programs,
    store,
  };
}

describe("Module management", () => {
  it("installs a validated frozen version disabled and returns declared views without host URLs", async () => {
    const { management, module, content, installation } = await fixture();
    expect(installation).toMatchObject({
      contentId: content.id,
      generation: 0,
      moduleId: module.id,
      status: "disabled",
    });
    expect(
      await management.getInstallation({ installationId: installation.id })
    ).toEqual({ grants: [], installation });
    expect(await management.views({ installationId: installation.id })).toEqual(
      [{ id: "home", path: "/", title: "Home" }]
    );
    expect(
      (await management.listVersions({ moduleId: module.id })).items.map(
        (version) => version.contentId
      )
    ).toEqual([content.id]);
  });

  it("refuses source-only, missing, and foreign Content before creating an Installation", async () => {
    const { management, module, content, artifacts } = await fixture();
    const foreign = await moduleFixture();
    await expect(
      management.createInstallation({
        contentId: foreign.content.id,
        moduleId: module.id,
      })
    ).rejects.toBeInstanceOf(ModuleStoreConflictError);
    const ready = await artifacts.revise({
      artifactId: module.artifactId,
      contentId: content.id,
      expectedUpdatedAt: content.updatedAt,
    });
    await expect(
      management.createInstallation({
        contentId: ready.id,
        moduleId: module.id,
      })
    ).rejects.toThrow("frozen");
    expect((await management.listInstallations()).items).toHaveLength(1);
  });

  it("keeps view discovery pinned while editing changes the Artifact's active Content", async () => {
    const { management, module, content, artifacts, installation } =
      await fixture();
    await artifacts.revise({
      artifactId: module.artifactId,
      changes: {
        put: {
          "source/foundry.module.json": {
            bytes: JSON.stringify({
              ...VALID_MANIFEST,
              views: { other: { path: "/other" } },
            }),
          },
        },
      },
      contentId: content.id,
      expectedUpdatedAt: content.updatedAt,
    });
    expect(await management.views({ installationId: installation.id })).toEqual(
      [{ id: "home", path: "/", title: "Home" }]
    );
  });

  it("selects through the supervisor, preserving backup and generation fences", async () => {
    const { management, module, content, artifacts, installation, files } =
      await fixture();
    const ready = await artifacts.revise({
      artifactId: module.artifactId,
      contentId: content.id,
      expectedUpdatedAt: content.updatedAt,
    });
    const next = await artifacts.freeze(ready.id, { tag: "2.0.0" });
    const selected = await management.selectVersion({
      contentId: next.id,
      expectedGeneration: 0,
      installationId: installation.id,
    });
    expect(selected).toMatchObject({
      contentId: next.id,
      generation: 1,
      status: "disabled",
    });
    expect(files.backup).toHaveBeenCalledOnce();
    await expect(
      management.selectVersion({
        contentId: content.id,
        expectedGeneration: 0,
        installationId: installation.id,
      })
    ).rejects.toMatchObject({ code: "stale-generation" });
    expect(
      (await management.getInstallation({ installationId: installation.id }))
        ?.installation.contentId
    ).toBe(next.id);
  });

  it("deletes all paginated installations before archiving the Module Artifact", async () => {
    const { management, module, content, artifacts, store, files } =
      await fixture();
    await management.createInstallation({
      contentId: content.id,
      moduleId: module.id,
    });
    await management.createInstallation({
      contentId: content.id,
      moduleId: module.id,
    });
    const list = store.listInstallations.bind(store);
    vi.spyOn(store, "listInstallations").mockImplementation((input) =>
      list({ ...input, limit: 1 })
    );
    await management.deleteModule({ moduleId: module.id });
    expect(files.delete).toHaveBeenCalledTimes(3);
    expect(await store.loadModule(module.id)).toBeNull();
    expect((await artifacts.get(module.artifactId))?.status).toBe("archived");
    expect((await store.listInstallations()).items).toEqual([]);
  });

  it("keeps the Module registered when archiving fails so a retry completes", async () => {
    const { management, module, artifacts, store } = await fixture();
    // deleteModule archives through its transaction handle, not the manager.
    const archive = vi
      .spyOn(ArtifactTransaction.prototype, "archive")
      .mockRejectedValueOnce(new Error("archive failed"));
    try {
      await expect(
        management.deleteModule({ moduleId: module.id })
      ).rejects.toThrow("archive failed");
      expect(await store.loadModule(module.id)).toEqual(module);
      await management.deleteModule({ moduleId: module.id });
      expect(await store.loadModule(module.id)).toBeNull();
      expect((await artifacts.get(module.artifactId))?.status).toBe("archived");
    } finally {
      archive.mockRestore();
    }
  });

  it("keeps registration and Artifact when installation cleanup fails", async () => {
    const { management, module, artifacts, store, files } = await fixture();
    files.delete.mockRejectedValueOnce(new Error("writers still live"));
    await expect(
      management.deleteModule({ moduleId: module.id })
    ).rejects.toThrow("writers still live");
    expect(await store.loadModule(module.id)).toEqual(module);
    expect((await artifacts.get(module.artifactId))?.status).toBe("published");
    expect((await store.listInstallations()).items).toHaveLength(1);
  });
});
