import { contentIdSchema } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import {
  createModuleProjects,
  MODULE_MIME,
  type ModuleManifest,
  ModuleStoreConflictError,
  moduleIdSchema,
} from "@foundry/modules";
import { describe, expect, it } from "vitest";
import { createModulePersistence } from "~/main/modules/artifact-store";

const source = {
  "foundry.module.json": JSON.stringify({
    capabilities: [],
    compatibility: { gateway: "1", runtime: "bun@1" },
    format: "foundry.module-manifest/1",
    program: { entry: "outputs/packages/server/dist/index.js" },
    views: { home: { path: "/" } },
  }),
};

describe("Module persistence over Artifact metadata", () => {
  it("lets exactly one of two concurrent creates of one id register it", async () => {
    const persistence = createModulePersistence(new MemoryArtifactStore());
    const projects = createModuleProjects({
      artifacts: persistence.artifacts,
      store: persistence.modules,
    });
    const id = moduleIdSchema.parse("raced");

    const created = await Promise.all([
      projects.create({ id, name: "First", source }),
      projects.create({ id, name: "Second", source }),
    ]);

    expect(created.map((project) => project.idempotent).sort()).toEqual([
      false,
      true,
    ]);
    expect(created[0]?.artifactId).toBe(created[1]?.artifactId);
    const registered = await persistence.registered();
    expect(registered.map((artifact) => artifact.metadata.moduleId)).toEqual([
      id,
    ]);
  });

  it("lets exactly one of two concurrent registrations of one id on two Artifacts land", async () => {
    const persistence = createModulePersistence(new MemoryArtifactStore());
    const [a, b] = await Promise.all(
      ["a", "b"].map((name) =>
        persistence.artifacts.create({ name, type: MODULE_MIME })
      )
    );
    const id = moduleIdSchema.parse("raced");

    const results = await Promise.allSettled(
      [a, b].map((artifact) =>
        persistence.modules.registerModule({
          module: { artifactId: artifact?.id as never, id },
        })
      )
    );

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      ModuleStoreConflictError
    );
    expect(await persistence.registered()).toHaveLength(1);
  });

  it("lets exactly one of two concurrent, different retained manifests for one Content land", async () => {
    const persistence = createModulePersistence(new MemoryArtifactStore());
    const artifact = await persistence.artifacts.create({
      name: "a",
      type: MODULE_MIME,
    });
    const module = { artifactId: artifact.id, id: moduleIdSchema.parse("m") };
    const contentId = contentIdSchema.parse("content");
    const manifestOf = (path: string) =>
      ({
        ...JSON.parse(source["foundry.module.json"]),
        views: { home: { path } },
      }) as ModuleManifest;

    const results = await Promise.allSettled([
      persistence.modules.retainManifest({
        contentId,
        manifest: manifestOf("/first"),
        module,
      }),
      persistence.modules.retainManifest({
        contentId,
        manifest: manifestOf("/second"),
        module,
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await persistence.modules.loadRetainedManifest(contentId)).toEqual(
      manifestOf("/first")
    );
  });

  it("joins nested artifacts and modules calls into an open transaction and sees uncommitted writes", async () => {
    const persistence = createModulePersistence(new MemoryArtifactStore());
    const id = moduleIdSchema.parse("joined");

    const seen = await persistence.artifacts.transaction(async () => {
      const created = await persistence.artifacts.create({
        name: "Joined",
        type: MODULE_MIME,
      });
      await persistence.modules.registerModule({
        module: { artifactId: created.id, id },
      });
      return {
        artifact: await persistence.artifacts.get(created.id),
        module: await persistence.modules.loadModule(id),
      };
    });

    expect(seen.artifact?.metadata.moduleId).toBe(id);
    expect(seen.module).toEqual({
      artifactId: seen.artifact?.id,
      id,
    });
    expect(await persistence.modules.loadModule(id)).toEqual(seen.module);
  });

  it("rolls back the whole transaction when a joined call fails, even if the callback catches it", async () => {
    const persistence = createModulePersistence(new MemoryArtifactStore());
    const created = await persistence.artifacts.create({
      name: "Before",
      type: MODULE_MIME,
    });
    const id = moduleIdSchema.parse("rolled-back");
    let caught: unknown;

    await expect(
      persistence.artifacts.transaction(async () => {
        await persistence.artifacts.rename(created.id, "After");
        try {
          await persistence.modules.registerModule({
            module: {
              artifactId: "missing-artifact" as never,
              id,
            },
          });
        } catch (error) {
          caught = error;
        }
      })
    ).rejects.toBeInstanceOf(ModuleStoreConflictError);

    expect(caught).toBeInstanceOf(ModuleStoreConflictError);
    expect((await persistence.artifacts.get(created.id))?.name).toBe("Before");
    expect(await persistence.modules.loadModule(id)).toBeNull();
  });

  it("does not join work scheduled during a transaction after it settles", async () => {
    const persistence = createModulePersistence(new MemoryArtifactStore());
    const created = await persistence.artifacts.create({
      name: "Initial",
      type: MODULE_MIME,
    });
    let delayed: Promise<unknown> | undefined;

    await persistence.artifacts.transaction(async () => {
      await persistence.artifacts.rename(created.id, "InTransaction");
      delayed = new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      }).then(() => persistence.artifacts.rename(created.id, "AfterSettle"));
    });

    expect((await persistence.artifacts.get(created.id))?.name).toBe(
      "InTransaction"
    );
    await delayed;
    expect((await persistence.artifacts.get(created.id))?.name).toBe(
      "AfterSettle"
    );
  });
});
