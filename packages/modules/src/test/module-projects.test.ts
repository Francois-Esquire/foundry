import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { describe, expect, it, vi } from "vitest";

import { moduleIdSchema } from "../domain";
import { createModuleProjects, ModuleProjectError } from "../projects";
import { ModuleStoreConflictError } from "../store/contract";
import { InMemoryModuleStore } from "../store/memory";
import { VALID_MANIFEST } from "./helpers/module-fixture";

const id = moduleIdSchema.parse("notes");
const source = {
  "bun.lock": "captured lock",
  "foundry.module.json": JSON.stringify(VALID_MANIFEST),
  "src/index.ts": "export {};",
};

async function fixture() {
  const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const store = new InMemoryModuleStore();
  const projects = createModuleProjects({ artifacts, store });
  const project = await projects.create({ id, name: "Notes", source });
  return { artifacts, project, projects, store };
}

describe("Module projects", () => {
  it("creates source-backed identity once without creating a version or installation", async () => {
    const { artifacts, store, projects, project } = await fixture();
    expect(project.idempotent).toBe(false);
    expect(await projects.create({ id, name: "Again", source })).toEqual({
      ...project,
      idempotent: true,
    });
    expect((await artifacts.list()).items).toHaveLength(1);
    expect((await artifacts.get(project.artifactId))?.name).toBe("Notes");
    expect((await store.listInstallations()).items).toEqual([]);
    expect((await artifacts.listContents(project.artifactId))[0]).toMatchObject(
      { state: "ready", tag: null }
    );
    expect((await projects.workspaceSource({ moduleId: id })).source).toEqual(
      source
    );
  });

  it("serializes concurrent creation of one identity", async () => {
    const { artifacts, store } = await fixture();
    const projects = createModuleProjects({ artifacts, store });
    const other = moduleIdSchema.parse("other");
    const created = await Promise.all([
      projects.create({ id: other, name: "Other", source }),
      projects.create({ id: other, name: "Other", source }),
    ]);
    expect(created.map((project) => project.idempotent).sort()).toEqual([
      false,
      true,
    ]);
    expect(created[0].artifactId).toBe(created[1].artifactId);
    expect((await artifacts.list()).items).toHaveLength(2);
  });

  it.each(["../escape", "/absolute", "a\\b", "empty//part", "nul\0path"])(
    "refuses invalid path %j before writing",
    async (path) => {
      const { artifacts, store } = await fixture();
      const projects = createModuleProjects({ artifacts, store });
      await expect(
        projects.create({
          id: moduleIdSchema.parse("bad"),
          name: "Bad",
          source: { ...source, [path]: "bad" },
        })
      ).rejects.toBeInstanceOf(ModuleProjectError);
      expect((await artifacts.list()).items).toHaveLength(1);
    }
  );

  it("rejects path collisions and missing or malformed manifests", async () => {
    const { projects } = await fixture();
    const invalidSources: Readonly<Record<string, string>>[] = [
      { ...source, src: "conflicts" },
      { "src/index.ts": "no manifest" },
      { "foundry.module.json": "{}" },
    ];
    for (const invalid of invalidSources) {
      await expect(
        projects.create({
          id: moduleIdSchema.parse("bad"),
          name: "Bad",
          source: invalid,
        })
      ).rejects.toBeInstanceOf(ModuleProjectError);
    }
  });

  it("fences saves by Artifact, Content, and revision; concurrent editors cannot overwrite", async () => {
    const { projects, artifacts } = await fixture();
    const opened = await projects.workspaceSource({ moduleId: id });
    const first = { ...source, "src/index.ts": "export const first = 1;" };
    const second = { ...source, "src/index.ts": "export const second = 2;" };
    const results = await Promise.allSettled([
      projects.saveWorkspaceSource({
        expected: opened.binding,
        moduleId: id,
        source: first,
      }),
      projects.saveWorkspaceSource({
        expected: opened.binding,
        moduleId: id,
        source: second,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" ? rejected.reason : null
    ).toBeInstanceOf(ModuleStoreConflictError);
    const saved = await projects.workspaceSource({ moduleId: id });
    expect(saved.source).toEqual(first);
    expect(saved.binding.updatedAt.getTime()).toBeGreaterThan(
      opened.binding.updatedAt.getTime()
    );
    expect((await artifacts.getContent(saved.binding.contentId))?.state).toBe(
      "ready"
    );
  });

  it("persists incomplete manifest edits without cutting a version", async () => {
    const { projects, artifacts, project } = await fixture();
    const opened = await projects.workspaceSource({ moduleId: id });
    const incomplete = { ...source, "foundry.module.json": "{" };
    const saved = await projects.saveWorkspaceSource({
      expected: opened.binding,
      moduleId: id,
      source: incomplete,
    });
    expect((await projects.workspaceSource({ moduleId: id })).source).toEqual(
      incomplete
    );
    const withoutManifest = { "src/index.ts": "draft" };
    await projects.saveWorkspaceSource({
      expected: saved,
      moduleId: id,
      source: withoutManifest,
    });
    expect((await projects.workspaceSource({ moduleId: id })).source).toEqual(
      withoutManifest
    );
    expect(await artifacts.listContents(project.artifactId)).toHaveLength(1);
    await expect(
      projects.saveWorkspaceSource({
        expected: (await projects.workspaceSource({ moduleId: id })).binding,
        moduleId: id,
        source: {},
      })
    ).rejects.toBeInstanceOf(ModuleProjectError);
  });

  it("revises frozen source without changing the released bytes and discards stale outputs", async () => {
    const { projects, artifacts, project } = await fixture();
    const content = (await artifacts.get(project.artifactId))?.content;
    if (!content) {
      throw new Error("Expected source Content");
    }
    const built = await artifacts.write({
      artifactId: project.artifactId,
      changes: { put: { "outputs/program/server.js": { bytes: "release" } } },
      expectedContentId: content.id,
      freeze: { tag: "1.0.0" },
      metadata: { entry: "outputs/program/server.js" },
    });
    const opened = await projects.workspaceSource({ moduleId: id });
    const saved = await projects.saveWorkspaceSource({
      expected: opened.binding,
      moduleId: id,
      source: { ...source, "src/index.ts": "next" },
    });
    expect(saved.contentId).not.toBe(built.id);
    expect((await artifacts.getContent(built.id))?.state).toBe("frozen");
    expect(
      new TextDecoder().decode(
        (await artifacts.readFile(built.id, "outputs/program/server.js"))?.blob
      )
    ).toBe("release");
    const next = await artifacts.getContent(saved.contentId);
    expect(next?.tree["outputs/program/server.js"]).toBeUndefined();
    expect(next?.metadata.entry).toBeUndefined();
    await expect(
      projects.saveWorkspaceSource({
        expected: opened.binding,
        moduleId: id,
        source,
      })
    ).rejects.toBeInstanceOf(ModuleStoreConflictError);
  });

  it("refuses corrupted or non-UTF-8 source rather than returning altered bytes", async () => {
    const { projects, artifacts } = await fixture();
    const read = artifacts.readFile.bind(artifacts);
    vi.spyOn(artifacts, "readFile").mockImplementation(
      async (contentId, path) => {
        const file = await read(contentId, path);
        return file === null
          ? null
          : { ...file, blob: new TextEncoder().encode("tampered") };
      }
    );
    await expect(projects.workspaceSource({ moduleId: id })).rejects.toThrow(
      "byte verification"
    );
    vi.restoreAllMocks();
    const opened = await projects.workspaceSource({ moduleId: id });
    await artifacts.write({
      artifactId: opened.binding.artifactId,
      changes: {
        put: { "source/src/index.ts": { bytes: new Uint8Array([0xff]) } },
      },
      expectedContentId: opened.binding.contentId,
    });
    await expect(projects.workspaceSource({ moduleId: id })).rejects.toThrow(
      "UTF-8"
    );
  });
});
