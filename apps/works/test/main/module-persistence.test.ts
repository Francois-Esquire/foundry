import { contentIdSchema } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { MODULE_MIME } from "@foundry/modules/constants";
import { moduleIdSchema } from "@foundry/modules/domain";
import { ModuleStoreConflictError } from "@foundry/modules/errors";
import type { ModuleManifest } from "@foundry/modules/manifest";
import { createModuleProjects } from "@foundry/modules/projects";
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
});
