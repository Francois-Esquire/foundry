import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { MODULE_MIME } from "@foundry/modules/constants";
import { defineModuleVersion, moduleIdSchema } from "@foundry/modules/domain";
import { encodeModulePackage } from "@foundry/modules/package";
import { afterEach, describe, expect, it } from "vitest";
import { createModuleLibrary, openModuleLibrary } from "~/main/modules/library";
import { fakeClient, openFakeVault } from "../helpers/fake-api";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function temporaryLibrary() {
  const path = await mkdtemp(join(tmpdir(), "works-modules-"));
  directories.push(path);
  return { library: openModuleLibrary(path), path };
}

describe("Module library", () => {
  it("rolls back registration with authored Content when persistence fails", async () => {
    const store = new InMemoryArtifactStore({
      commit: () => {
        throw new Error("Disk full");
      },
    });
    const library = createModuleLibrary(store);
    await expect(library.create("Unsaved")).rejects.toThrow("Disk full");
    expect(await library.list()).toEqual([]);
  });

  it("imports an output-only release idempotently and reopens its identity", async () => {
    const manager = new ArtifactManager({ store: new InMemoryArtifactStore() });
    const bytes = new TextEncoder().encode("export {};");
    const artifact = await manager.create({
      entries: { "outputs/program.js": { bytes } },
      freeze: { tag: "1.0.0" },
      name: "Imported release",
      type: MODULE_MIME,
    });
    const { content } = artifact;
    if (!(content && "tree" in content)) {
      throw new Error("Expected resolved fixture Content");
    }
    const module = {
      artifactId: artifact.id,
      id: moduleIdSchema.parse("imported-module"),
    };
    const manifest = {
      capabilities: [],
      compatibility: { gateway: "1", runtime: "bun@1" },
      format: "foundry.module/1",
      program: { entry: "outputs/program.js" },
      views: {},
    };
    const version = defineModuleVersion({
      artifact,
      content,
      manifest,
      module,
    });
    const encoded = await encodeModulePackage({
      artifact,
      content,
      files: { "outputs/program.js": bytes },
      module,
      version,
    });
    const { path, library } = await temporaryLibrary();
    const first = await library.importPackage(encoded);
    expect(await library.importPackage(encoded)).toMatchObject({
      artifactId: first.artifactId,
      id: first.id,
    });
    const reopened = openModuleLibrary(path);
    expect(await reopened.list()).toHaveLength(1);
    expect(await reopened.details(module.id)).toMatchObject({
      name: "Imported release",
      source: {},
    });
  });

  it("rejects malformed persisted Module identity", async () => {
    const store = new InMemoryArtifactStore();
    const library = createModuleLibrary(store);
    const module = await library.create("Corrupt registration");
    const manager = new ArtifactManager({ store });
    const [artifact] = (await manager.list()).items;
    if (!artifact) {
      throw new Error("Expected artifact");
    }
    expect(artifact.id).toBe(module.artifactId);
    await manager.patchArtifactMetadata(artifact.id, { moduleId: 42 });
    await expect(library.list()).rejects.toThrow();
  });

  it("persists Module identity and authored bytes across a fresh host", async () => {
    const { path, library } = await temporaryLibrary();
    const module = await library.create("My persistent module");
    const reopened = openModuleLibrary(path);
    expect(await reopened.list()).toEqual([module]);
    const details = await reopened.details(module.id);
    expect(details?.artifactId).toBe(module.artifactId);
    expect(details?.source["README.md"]).toContain("My persistent module");
    expect(
      JSON.parse(details?.source["foundry.module.json"] ?? "")
    ).toMatchObject({ format: "foundry.module/1" });
  });

  it("serializes concurrent creations without dropping registrations", async () => {
    const { path, library } = await temporaryLibrary();
    const created = await Promise.all([
      library.create("First"),
      library.create("Second"),
    ]);
    expect(
      (await openModuleLibrary(path).list()).map((module) => module.id).sort()
    ).toEqual(created.map((module) => module.id).sort());
  });

  it("does not overwrite corrupt storage with an empty library", async () => {
    const { path, library } = await temporaryLibrary();
    await library.create("Keep me");
    const file = join(path, "modules", "artifacts.json");
    await writeFile(file, "broken records");
    await expect(openModuleLibrary(path).create("Must fail")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("broken records");
  });

  it("rejects invalid imports and blank names through the router", async () => {
    const library = createModuleLibrary(new InMemoryArtifactStore());
    const client = fakeClient(await openFakeVault(), library);
    await expect(
      client.modules.importPackage({ encoded: "{}" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client.modules.create({ name: "  " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(await client.modules.list()).toEqual([]);
    await expect(
      client.modules.details({ id: "missing" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("creates and opens the same module through the typed router", async () => {
    const client = fakeClient(await openFakeVault());
    const module = await client.modules.create({ name: "Router project" });
    expect(await client.modules.list()).toEqual([module]);
    expect(await client.modules.details({ id: module.id })).toMatchObject({
      id: module.id,
      name: "Router project",
    });
  });
});
