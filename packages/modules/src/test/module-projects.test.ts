import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { describe, expect, it, vi } from "vitest";

import { moduleIdSchema } from "../domain";
import { createModuleProjects, ModuleProjectError } from "../projects";
import { ModuleStoreConflictError } from "../store/contract";
import { InMemoryModuleStore } from "../store/memory";
import { VALID_MANIFEST } from "./helpers/module-fixture";
import {
  builtManifest,
  publishedModule,
  WEATHER,
  weatherRequest,
} from "./helpers/published-module";

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

  it("stamps a host's attribution on the saved Content in the same write", async () => {
    const { projects, artifacts, project } = await fixture();
    const opened = await projects.workspaceSource({ moduleId: id });
    const saved = await projects.saveWorkspaceSource({
      expected: opened.binding,
      metadata: { origin: { runId: "rn-1" } },
      moduleId: id,
      source,
    });
    const content = await artifacts.getContent(saved.contentId);
    expect(content?.metadata).toMatchObject({ origin: { runId: "rn-1" } });
    expect(content?.metadata.entry).toBeUndefined();
    expect(content?.updatedAt.getTime()).toBe(saved.updatedAt.getTime());
    expect(await artifacts.listContents(project.artifactId)).toHaveLength(1);
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

describe("Module build publication", () => {
  const outputs = {
    "packages/server/dist/index.js": new TextEncoder().encode("export {};"),
  };
  const catalog = { capabilities: [] };

  async function saved() {
    const module = await publishedModule();
    const { binding, source: current } = await module.projects.workspaceSource({
      moduleId: module.moduleId,
    });
    return { ...module, binding, source: current };
  }

  it("freezes source, outputs and attribution as one tagged Version on the read binding", async () => {
    const {
      artifacts,
      binding,
      moduleId,
      projects,
      source: current,
    } = await saved();
    const published = await projects.publish({
      catalog,
      expected: binding,
      metadata: { origin: { runId: "build-1" } },
      moduleId,
      outputs,
      source: { ...current, "bun.lock": "resolved" },
      tag: "1.0.0",
    });
    expect(published.version).toMatchObject({ moduleId, tag: "1.0.0" });
    expect(published.binding.contentId).toBe(published.version.contentId);
    const content = await artifacts.getContent(published.version.contentId);
    expect(content).toMatchObject({
      metadata: { origin: { runId: "build-1" } },
      state: "frozen",
      tag: "1.0.0",
    });
    expect(Object.keys(content?.tree ?? {}).sort()).toEqual(
      expect.arrayContaining([
        "outputs/packages/server/dist/index.js",
        "source/bun.lock",
        "source/foundry.module.json",
      ])
    );
    // The frozen Version is the saved source now; the next save revises it.
    const next = await projects.workspaceSource({ moduleId });
    expect(next.binding).toEqual(published.binding);
    await projects.saveWorkspaceSource({
      expected: next.binding,
      moduleId,
      source: next.source,
    });
  });

  it("refuses once the source it was built from moved, or its tag is taken", async () => {
    const {
      artifacts,
      binding,
      moduleId,
      projects,
      publish,
      source: current,
    } = await saved();
    await projects.saveWorkspaceSource({
      expected: binding,
      moduleId,
      source: { ...current, "src/edit.ts": "edited" },
    });
    const stale = projects.publish({
      catalog,
      expected: binding,
      moduleId,
      outputs,
      source: current,
      tag: "1.0.0",
    });
    await expect(stale).rejects.toThrow(ModuleStoreConflictError);
    await expect(stale).rejects.toThrow("changed during the build");

    await publish("1.0.0");
    const fresh = await projects.workspaceSource({ moduleId });
    await expect(
      projects.publish({
        catalog,
        expected: fresh.binding,
        moduleId,
        outputs,
        source: fresh.source,
        tag: "1.0.0",
      })
    ).rejects.toThrow("This release version already exists");
    const versions = await artifacts.listContents(fresh.binding.artifactId, {
      state: "frozen",
      tagged: true,
    });
    expect(versions.map((version) => version.tag)).toEqual(["1.0.0"]);
  });

  it("refuses outputs outside a package dist, uncatalogued capabilities and missing entries", async () => {
    const { binding, moduleId, projects, source: current } = await saved();
    const attempt = (change: object) =>
      projects.publish({
        catalog,
        expected: binding,
        moduleId,
        outputs,
        source: current,
        tag: "1.0.0",
        ...change,
      });
    await expect(
      attempt({ outputs: { "packages/server/src/index.ts": new Uint8Array() } })
    ).rejects.toThrow("outside a package dist directory");
    await expect(
      attempt({
        source: {
          ...current,
          "foundry.module.json": JSON.stringify(
            builtManifest([weatherRequest(["Oslo"])])
          ),
        },
      })
    ).rejects.toThrow(WEATHER);
    await expect(
      attempt({
        outputs: {
          "packages/app/dist/index.html": new TextEncoder().encode("<p>"),
        },
      })
    ).rejects.toThrow("outputs/packages/server/dist/index.js");
    await expect(attempt({ tag: "latest" })).rejects.toThrow();
  });
});
