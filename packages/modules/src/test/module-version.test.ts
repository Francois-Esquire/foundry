import type { Content, FileInputs } from "@foundry/artifacts";
import {
  ArtifactManager,
  artifactIdSchema,
  contentIdSchema,
  InMemoryArtifactStore,
} from "@foundry/artifacts";
import { describe, expect, it } from "vitest";

import { MODULE_MIME } from "../constants";
import { defineModule, moduleIdSchema } from "../domain";
import {
  ModuleManifestValidationError,
  parseModuleManifest,
} from "../manifest";
import { InMemoryModuleStore } from "../store/memory";
import {
  createModuleVersions,
  MODULE_CONTENT_MANIFEST_PATH,
  pruneRetainedManifests,
} from "../version";
import { PROGRAM_FILES, VALID_MANIFEST } from "./helpers/module-fixture";

const RETAINED_MANIFEST = parseModuleManifest({
  ...VALID_MANIFEST,
  views: { retained: { path: "/retained" } },
});

function built(manifest: unknown = VALID_MANIFEST): FileInputs {
  return {
    ...PROGRAM_FILES,
    [MODULE_CONTENT_MANIFEST_PATH]: { bytes: JSON.stringify(manifest) },
  };
}

async function fixture(entries: FileInputs = built(), tag = "1.0.0") {
  const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const artifact = await artifacts.create({
    entries,
    freeze: { tag },
    id: artifactIdSchema.parse("artifact-1"),
    name: "Module",
    type: MODULE_MIME,
  });
  if (!artifact.content) {
    throw new Error("Fixture requires Content");
  }
  const module = defineModule({
    artifact,
    id: moduleIdSchema.parse("module-1"),
  });
  const store = new InMemoryModuleStore();
  await store.registerModule({ module });
  const versions = createModuleVersions({ artifacts, store });
  let latest: Content = artifact.content;
  /** Freezes a successor of the latest Content under `nextTag`. */
  const release = async (
    nextTag: string | undefined,
    nextEntries: FileInputs = built()
  ): Promise<Content> => {
    const successor = await artifacts.revise({
      artifactId: artifact.id,
      changes: { put: nextEntries, replace: true },
      contentId: latest.id,
      expectedUpdatedAt: latest.updatedAt,
    });
    latest = await artifacts.freeze(
      successor.id,
      nextTag === undefined ? {} : { tag: nextTag }
    );
    return latest;
  };
  return {
    artifact,
    artifacts,
    content: artifact.content,
    module,
    release,
    store,
    versions,
  };
}

describe("Module versions", () => {
  it("resolves a pinned Content from its embedded manifest source", async () => {
    const { content, module, versions } = await fixture();
    expect(
      await versions.load({ contentId: content.id, moduleId: module.id })
    ).toEqual({
      artifactId: module.artifactId,
      contentId: content.id,
      digest: content.digest,
      manifest: parseModuleManifest(VALID_MANIFEST),
      moduleId: module.id,
      tag: "1.0.0",
    });
  });

  it("resolves the pinned Content, not the Artifact's active one", async () => {
    const { content, module, versions, release } = await fixture();
    await release(
      "2.0.0",
      built({ ...VALID_MANIFEST, views: { next: { path: "/next" } } })
    );
    const pinned = await versions.load({
      contentId: content.id,
      moduleId: module.id,
    });
    expect(pinned?.tag).toBe("1.0.0");
    expect(pinned?.manifest.views).toEqual({});
  });

  it("lets a retained manifest outrank the embedded source without touching the Content", async () => {
    const { artifacts, content, module, store, versions } = await fixture();
    await store.retainManifest({
      contentId: content.id,
      manifest: RETAINED_MANIFEST,
      module,
    });
    const version = await versions.load({
      contentId: content.id,
      moduleId: module.id,
    });
    expect(version?.manifest).toEqual(RETAINED_MANIFEST);
    expect((await artifacts.getContent(content.id))?.digest).toBe(
      content.digest
    );
  });

  it("resolves an output-only Content from its retained manifest and refuses it without one", async () => {
    const { content, module, store, versions } = await fixture(PROGRAM_FILES);
    await expect(
      versions.load({ contentId: content.id, moduleId: module.id })
    ).rejects.toThrow("carries no Module manifest");
    await store.retainManifest({
      contentId: content.id,
      manifest: parseModuleManifest(VALID_MANIFEST),
      module,
    });
    expect(
      (await versions.load({ contentId: content.id, moduleId: module.id }))
        ?.manifest
    ).toEqual(parseModuleManifest(VALID_MANIFEST));
  });

  it("returns null for a missing Module or Content", async () => {
    const { content, module, versions } = await fixture();
    expect(
      await versions.load({
        contentId: content.id,
        moduleId: moduleIdSchema.parse("missing"),
      })
    ).toBeNull();
    expect(
      await versions.load({
        contentId: contentIdSchema.parse("missing"),
        moduleId: module.id,
      })
    ).toBeNull();
  });

  it("refuses a Content of another Module's Artifact", async () => {
    const { artifacts, module, versions } = await fixture();
    const foreign = await artifacts.create({
      entries: built(),
      freeze: { tag: "1.0.0" },
      id: artifactIdSchema.parse("artifact-2"),
      name: "Other",
      type: MODULE_MIME,
    });
    if (!foreign.content) {
      throw new Error("Fixture requires Content");
    }
    await expect(
      versions.load({ contentId: foreign.content.id, moduleId: module.id })
    ).rejects.toBeInstanceOf(ModuleManifestValidationError);
  });

  it("refuses mutable, untagged, and non-SemVer Contents", async () => {
    const { artifacts, artifact, content, module, versions } = await fixture();
    const ready = await artifacts.revise({
      artifactId: artifact.id,
      changes: { put: built(), replace: true },
      contentId: content.id,
      expectedUpdatedAt: content.updatedAt,
    });
    await expect(
      versions.load({ contentId: ready.id, moduleId: module.id })
    ).rejects.toThrow("must be frozen");
    const untagged = await artifacts.freeze(ready.id);
    await expect(
      versions.load({ contentId: untagged.id, moduleId: module.id })
    ).rejects.toThrow("has no SemVer tag");

    const other = await fixture(built(), "1.0.0");
    const named = await other.release("nightly");
    await expect(
      other.versions.load({ contentId: named.id, moduleId: other.module.id })
    ).rejects.toBeInstanceOf(ModuleManifestValidationError);
  });

  it("refuses a manifest whose output path is absent and unparseable manifest source", async () => {
    const missing = await fixture(
      built({
        ...VALID_MANIFEST,
        program: { entry: "outputs/program/missing.js" },
      })
    );
    await expect(
      missing.versions.load({
        contentId: missing.content.id,
        moduleId: missing.module.id,
      })
    ).rejects.toThrow("absent from the Content tree");

    const broken = await fixture({
      ...PROGRAM_FILES,
      [MODULE_CONTENT_MANIFEST_PATH]: { bytes: "{ not json" },
    });
    await expect(
      broken.versions.load({
        contentId: broken.content.id,
        moduleId: broken.module.id,
      })
    ).rejects.toBeInstanceOf(ModuleManifestValidationError);
  });

  it("lists valid versions in Content id order through bounded pages, skipping the rest", async () => {
    const { content, module, versions, release } = await fixture();
    const second = await release("1.1.0");
    await release("nightly");
    await release(undefined);
    await release("1.2.0", PROGRAM_FILES);
    const third = await release("1.3.0");

    const expected = [content.id, second.id, third.id].sort((left, right) =>
      left.localeCompare(right)
    );
    const all = await versions.list({ moduleId: module.id });
    expect(all.items.map((version) => version.contentId)).toEqual(expected);
    expect(all.total).toBe(3);

    const first = await versions.list({
      moduleId: module.id,
      page: { limit: 2 },
    });
    expect(first.items.map((version) => version.contentId)).toEqual(
      expected.slice(0, 2)
    );
    expect(first.nextCursor).toBeDefined();
    const rest = await versions.list({
      moduleId: module.id,
      page: { cursor: first.nextCursor, limit: 2 },
    });
    expect(rest.items.map((version) => version.contentId)).toEqual(
      expected.slice(2)
    );
    expect(rest.nextCursor).toBeUndefined();

    expect(
      await versions.list({ moduleId: moduleIdSchema.parse("missing") })
    ).toMatchObject({ items: [], total: 0 });
  });

  it("prunes only retained manifests their Content reproduces, idempotently", async () => {
    const { artifacts, content, module, store, release } = await fixture();
    const disagreeing = await release("1.1.0");
    const outputOnly = await release("1.2.0", PROGRAM_FILES);
    const equal = parseModuleManifest(VALID_MANIFEST);
    await store.retainManifest({
      contentId: content.id,
      manifest: equal,
      module,
    });
    await store.retainManifest({
      contentId: disagreeing.id,
      manifest: RETAINED_MANIFEST,
      module,
    });
    await store.retainManifest({
      contentId: outputOnly.id,
      manifest: equal,
      module,
    });

    for (let pass = 0; pass < 2; pass += 1) {
      await pruneRetainedManifests({ artifacts, store });
      expect(
        (await store.listRetainedManifests()).map(({ contentId }) => contentId)
      ).toEqual(
        [disagreeing.id, outputOnly.id].sort((left, right) =>
          left.localeCompare(right)
        )
      );
    }
    expect(await store.loadRetainedManifest(disagreeing.id)).toEqual(
      RETAINED_MANIFEST
    );
    const versions = createModuleVersions({ artifacts, store });
    expect(
      (await versions.load({ contentId: content.id, moduleId: module.id }))
        ?.manifest
    ).toEqual(equal);
  });
});
