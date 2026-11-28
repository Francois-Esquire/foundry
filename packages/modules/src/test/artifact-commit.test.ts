import { Artifacts } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { describe, expect, it } from "vitest";
import {
  assertOwnsArtifactCommit,
  ModuleCrossStoreError,
} from "../artifact-commit";
import { defineModule, defineModuleVersion, moduleIdSchema } from "../domain";
import { createModuleManagement } from "../management";
import { Modules } from "../modules";
import { encodeModulePackage, importModulePackage } from "../package";
import { createModuleProjects } from "../projects";
import { MemoryModuleStore } from "../store/memory";
import { SqliteModuleStore } from "../store/sqlite";
import { failingArtifacts } from "./helpers/failing-artifacts";
import { moduleFixture, VALID_MANIFEST } from "./helpers/module-fixture";
import { libsqlDatabases } from "./helpers/sqlite";

const databases = libsqlDatabases("file");
const source = { "foundry.module.json": JSON.stringify(VALID_MANIFEST) };
const programs = {
  delete: () => Promise.resolve(),
  selectVersion: () => Promise.reject(new Error("unused")),
};

const STORES = [
  ["MemoryModuleStore", () => Promise.resolve(new MemoryModuleStore())],
  [
    "SqliteModuleStore on a file",
    async () =>
      new SqliteModuleStore({ database: await databases.open(), scope: "s" }),
  ],
] as const;

describe.each(STORES)("Create, import and delete over %s", (_name, open) => {
  it("complete on a retry after the Artifact write fails, and refuse a caller's Artifact transaction", async () => {
    const failing = failingArtifacts();
    const registry = new Modules({ store: await open() });
    const projects = createModuleProjects({
      artifacts: failing.artifacts,
      store: registry,
    });
    const management = createModuleManagement({
      artifacts: failing.artifacts,
      programs,
      store: registry,
    });
    const id = moduleIdSchema.parse("notes");

    await expect(
      projects.create({ id, name: "Notes", source })
    ).rejects.toThrow("simulated Artifact commit failure");
    expect(await registry.loadModule(id)).toBeNull();
    failing.fail = false;
    const { module } = await projects.create({ id, name: "Notes", source });
    await expect(
      failing.artifacts.transaction(() =>
        management.deleteModule({ moduleId: id })
      )
    ).rejects.toBeInstanceOf(ModuleCrossStoreError);

    failing.fail = true;
    await expect(management.deleteModule({ moduleId: id })).rejects.toThrow(
      "simulated Artifact commit failure"
    );
    expect(await registry.loadModule(id)).toEqual(module);
    failing.fail = false;
    await management.deleteModule({ moduleId: id });
    expect(await registry.loadModule(id)).toBeNull();
    expect((await failing.artifacts.get(module.artifactId))?.status).toBe(
      "archived"
    );
  });

  it("refuse an import onto another Module's Artifact, leaving it as it was, and land one that owns it", async () => {
    const target = await moduleFixture({ artifactId: "shared-artifact" });
    const registry = new Modules({ store: await open() });
    await registry.registerModule({
      module: defineModule({
        artifact: target.artifact,
        id: moduleIdSchema.parse("owner"),
      }),
    });
    const packaged = await moduleFixture({
      artifactId: "shared-artifact",
      tag: "2.0.0",
    });
    const encodedAs = (moduleId: string) => {
      const module = defineModule({
        artifact: packaged.artifact,
        id: moduleIdSchema.parse(moduleId),
      });
      return encodeModulePackage({
        artifact: packaged.artifact,
        content: packaged.content,
        files: packaged.bytes,
        module,
        version: defineModuleVersion({
          artifact: packaged.artifact,
          content: packaged.content,
          manifest: VALID_MANIFEST,
          module,
        }),
      });
    };
    const before = await target.system.listContents(target.artifact.id);

    await expect(
      importModulePackage({
        artifacts: target.system,
        encoded: await encodedAs("foreign"),
        modules: registry,
      })
    ).rejects.toThrow(
      "Artifact shared-artifact already belongs to Module owner"
    );
    expect(await target.system.listContents(target.artifact.id)).toEqual(
      before
    );

    const imported = await importModulePackage({
      artifacts: target.system,
      encoded: await encodedAs("owner"),
      modules: registry,
    });
    expect(imported.tag).toBe("2.0.0");
    expect(
      (await target.system.listContents(target.artifact.id)).map(
        ({ tag }) => tag
      )
    ).toEqual(["1.0.0", "2.0.0"]);
  });
});

describe("Artifacts on their own", () => {
  it("let a create run when no Artifact transaction is open", async () => {
    const artifacts = new Artifacts({
      store: new MemoryArtifactStore(),
    });
    const projects = createModuleProjects({
      artifacts,
      store: new Modules(),
    });
    const created = await projects.create({
      id: moduleIdSchema.parse("plain"),
      name: "Plain",
      source,
    });
    expect(created.idempotent).toBe(false);
  });

  it("refuses host-durability Artifacts immediately without relying on AsyncLocalStorage", async () => {
    const store = new MemoryArtifactStore();
    await store.transaction(async (view) => {
      const hostArtifacts = new Artifacts({ store: view });
      expect(hostArtifacts.durability).toBe("host");
      await expect(
        assertOwnsArtifactCommit(hostArtifacts, "Module project create")
      ).rejects.toBeInstanceOf(ModuleCrossStoreError);
    });
  });

  it("refuses a substrate that defers afterCommit without relying on AsyncLocalStorage", async () => {
    const deferred: (() => Promise<void>)[] = [];
    const joinedSubstrate = {
      transaction: async <T>(
        work: (
          artifacts: never,
          effects: { afterCommit(effect: () => Promise<void>): void }
        ) => Promise<T>
      ) =>
        work(undefined as never, {
          afterCommit: (effect) => {
            deferred.push(effect);
          },
        }),
    };
    await expect(
      assertOwnsArtifactCommit(joinedSubstrate, "Module delete")
    ).rejects.toBeInstanceOf(ModuleCrossStoreError);
    expect(deferred).toHaveLength(1);
  });
});
