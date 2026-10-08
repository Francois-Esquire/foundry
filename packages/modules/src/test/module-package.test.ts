import type { FileInputs } from "@foundry/artifacts";
import {
  ArtifactManager,
  digestTree,
  InMemoryArtifactStore,
} from "@foundry/artifacts";
import type { StorageTree } from "@foundry/core/storage";
import { storageTree } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { bytesToBase64 } from "@foundry/lib/encoding";
import { canonicalizeJson } from "@foundry/lib/json";
import { describe, expect, it } from "vitest";

import { defineModule, defineModuleVersion, moduleIdSchema } from "../domain";
import { encodeModulePackage, importModulePackage } from "../package";
import { InMemoryModuleStore } from "../store/memory";
import { createModuleVersions, MODULE_CONTENT_MANIFEST_PATH } from "../version";
import {
  moduleFixture,
  PROGRAM_FILES,
  VALID_MANIFEST,
} from "./helpers/module-fixture";

async function fixture(files?: FileInputs) {
  const { artifact, content, bytes } = await moduleFixture(
    files === undefined ? {} : { files }
  );
  const module = defineModule({
    artifact,
    id: moduleIdSchema.parse("module-1"),
  });
  const version = defineModuleVersion({
    artifact,
    content,
    manifest: VALID_MANIFEST,
    module,
  });
  return { artifact, bytes, content, module, version };
}

function withEmbeddedManifest(manifest: unknown): FileInputs {
  return {
    ...PROGRAM_FILES,
    [MODULE_CONTENT_MANIFEST_PATH]: {
      bytes: JSON.stringify(manifest),
      mime: "application/json",
    },
  };
}

async function encoded(source: Awaited<ReturnType<typeof fixture>>) {
  return encodeModulePackage({
    artifact: source.artifact,
    content: source.content,
    files: source.bytes,
    module: source.module,
    version: source.version,
  });
}

function importPackage(artifacts: ArtifactManager, text: string) {
  return importModulePackage({
    artifacts,
    encoded: text,
    modules: new InMemoryModuleStore(),
  });
}

class RejectingModuleStore extends InMemoryModuleStore {
  override retainManifest(): Promise<never> {
    return Promise.reject(new Error("injected Module persistence failure"));
  }
}

interface Envelope {
  content: {
    digest: string;
    tree: StorageTree;
    blobs: Record<string, string>;
    manifest: { program: { entry: string }; capabilities: unknown[] };
    manifestDigest: string;
  };
  module: { id: string };
}

async function alteredManifestPackage(
  source: Awaited<ReturnType<typeof fixture>>,
  text: string
): Promise<string> {
  const envelope = JSON.parse(await encoded(source)) as Envelope;
  const bytes = new TextEncoder().encode(text);
  const digest = await sha256Hex(bytes);
  envelope.content.tree = storageTree([
    ...Object.entries(envelope.content.tree)
      .filter(([path]) => path !== MODULE_CONTENT_MANIFEST_PATH)
      .map(([path, node]) => ({ path, ...node })),
    {
      bytes: bytes.length,
      digest,
      mime: "application/json",
      path: MODULE_CONTENT_MANIFEST_PATH,
      type: "file",
    },
    { path: "source", type: "directory" },
  ]);
  envelope.content.blobs[digest] = bytesToBase64(bytes);
  envelope.content.digest = await digestTree(envelope.content.tree);
  return canonicalizeJson(envelope);
}

describe("Module Package", () => {
  it.each([
    { target: "program/server.js", type: "symlink" },
    { type: "socket" },
    { type: "device" },
    { type: "pipe" },
  ] as const)("rejects $type outputs before persisting", async (entry) => {
    const source = await fixture();
    const envelope = JSON.parse(await encoded(source)) as Envelope;
    envelope.content.tree = {
      ...envelope.content.tree,
      "outputs/unsupported": entry,
    };
    envelope.content.digest = await digestTree(envelope.content.tree);
    const artifacts = new ArtifactManager({
      store: new InMemoryArtifactStore(),
    });
    const modules = new InMemoryModuleStore();

    await expect(
      importModulePackage({
        artifacts,
        encoded: canonicalizeJson(envelope),
        modules,
      })
    ).rejects.toThrow("must be a file or directory");
    expect(await artifacts.get(source.artifact.id)).toBeNull();
    expect(await modules.loadModule(source.module.id)).toBeNull();
  });

  it("preserves source links and empty output directories", async () => {
    const source = await fixture();
    const envelope = JSON.parse(await encoded(source)) as Envelope;
    envelope.content.tree = {
      ...envelope.content.tree,
      "outputs/empty": { type: "directory" },
      source: { type: "directory" },
      "source/program": {
        target: "../outputs/program/server.js",
        type: "symlink",
      },
    };
    envelope.content.digest = await digestTree(envelope.content.tree);
    const artifacts = new ArtifactManager({
      store: new InMemoryArtifactStore(),
    });

    const release = await importPackage(artifacts, canonicalizeJson(envelope));

    expect(await artifacts.getContent(release.contentId)).toMatchObject({
      tree: envelope.content.tree,
    });
  });

  it("round-trips one version as a frozen, tagged Content on the target", async () => {
    const source = await fixture();
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });
    const modules = new InMemoryModuleStore();

    const imported = await importModulePackage({
      artifacts: target,
      encoded: await encoded(source),
      modules,
    });

    expect(imported).toMatchObject({
      artifactId: source.artifact.id,
      digest: source.content.digest,
      moduleId: source.module.id,
      tag: "1.0.0",
    });
    const landed = await target.get(source.artifact.id);
    expect(landed).toMatchObject({
      name: source.artifact.name,
      status: "published",
      type: source.artifact.type,
    });
    expect(landed?.content).toMatchObject({
      digest: source.content.digest,
      state: "frozen",
      tag: "1.0.0",
      tree: storageTree(
        Object.entries(source.content.tree).map(([path, node]) => ({
          ...node,
          path,
        }))
      ),
    });
    expect(await modules.loadModule(source.module.id)).toEqual(source.module);
    // Output-only: the envelope manifest is the only copy, so it is retained
    // and the version resolves from the target alone.
    expect(await modules.loadRetainedManifest(imported.contentId)).toEqual(
      imported.manifest
    );
    expect(
      await createModuleVersions({ artifacts: target, store: modules }).load({
        contentId: imported.contentId,
        moduleId: source.module.id,
      })
    ).toEqual(imported);
  });

  it("retains nothing when the Content embeds the manifest it was packaged with", async () => {
    const source = await fixture(withEmbeddedManifest(VALID_MANIFEST));
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });
    const modules = new InMemoryModuleStore();

    const imported = await importModulePackage({
      artifacts: target,
      encoded: await encoded(source),
      modules,
    });

    expect(await modules.loadModule(source.module.id)).toEqual(source.module);
    expect(await modules.listRetainedManifests()).toEqual([]);
    expect(
      await createModuleVersions({ artifacts: target, store: modules }).load({
        contentId: imported.contentId,
        moduleId: source.module.id,
      })
    ).toEqual(imported);
  });

  it("rejects a package whose embedded manifest source disagrees, before persisting", async () => {
    const source = await fixture();
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });
    const modules = new InMemoryModuleStore();

    await expect(
      importModulePackage({
        artifacts: target,
        encoded: await alteredManifestPackage(
          source,
          JSON.stringify({ ...VALID_MANIFEST, views: { home: { path: "/" } } })
        ),
        modules,
      })
    ).rejects.toThrow("disagrees with its embedded source");
    expect(await target.get(source.artifact.id)).toBeNull();
    expect(await modules.loadModule(source.module.id)).toBeNull();
    expect(await modules.listRetainedManifests()).toEqual([]);
  });

  it("rejects unparseable embedded manifest source", async () => {
    const source = await fixture();
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });

    await expect(
      importPackage(target, await alteredManifestPackage(source, "{ not json"))
    ).rejects.toThrow("embedded Manifest source is invalid");
    expect(await target.get(source.artifact.id)).toBeNull();
  });

  it("refuses to export a retained legacy manifest that disagrees with frozen source", async () => {
    const source = await fixture(
      withEmbeddedManifest({
        ...VALID_MANIFEST,
        views: { home: { path: "/" } },
      })
    );
    await expect(encoded(source)).rejects.toThrow(
      "Cannot export a legacy version"
    );
  });

  it("importing the same version twice reuses the existing tagged Content", async () => {
    const source = await fixture();
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });
    const text = await encoded(source);

    const first = await importPackage(target, text);
    const second = await importPackage(target, text);

    expect(second.contentId).toBe(first.contentId);
    expect(
      await target.listContents(source.artifact.id, { state: "frozen" })
    ).toHaveLength(1);
  });

  it("adds a second version to an existing Artifact as another frozen Content", async () => {
    const one = await fixture();
    const two = await moduleFixture({
      artifactId: one.artifact.id,
      files: {
        "outputs/program/server.js": {
          bytes: "export const v = 2;",
          mime: "text/javascript",
        },
      },
      tag: "1.1.0",
    });
    const twoVersion = defineModuleVersion({
      artifact: two.artifact,
      content: two.content,
      manifest: VALID_MANIFEST,
      module: one.module,
    });
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });

    await importPackage(target, await encoded(one));
    const imported = await importPackage(
      target,
      await encodeModulePackage({
        artifact: two.artifact,
        content: two.content,
        files: two.bytes,
        module: one.module,
        version: twoVersion,
      })
    );

    expect(imported.tag).toBe("1.1.0");
    expect(
      (await target.listContents(one.artifact.id, { state: "frozen" })).map(
        (content) => content.tag
      )
    ).toEqual(["1.0.0", "1.1.0"]);
  });

  it("rejects a changed Content digest before persisting", async () => {
    const source = await fixture();
    const tampered = JSON.parse(await encoded(source)) as Envelope;
    tampered.content.digest = "not-the-real-digest";
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });

    await expect(
      importPackage(target, canonicalizeJson(tampered))
    ).rejects.toThrow("Content digest mismatch");
    expect(await target.get(source.artifact.id)).toBeNull();
  });

  it("rejects blob bytes that do not match their digest", async () => {
    const source = await fixture();
    const tampered = JSON.parse(await encoded(source)) as Envelope;
    for (const digest of Object.keys(tampered.content.blobs)) {
      tampered.content.blobs[digest] = "bm90LXRoZS1yZWFsLWJ5dGVz";
    }
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });

    await expect(
      importPackage(target, canonicalizeJson(tampered))
    ).rejects.toThrow("blob digest mismatch");
    expect(await target.get(source.artifact.id)).toBeNull();
  });

  it("refuses to encode a mismatched Artifact, Release, or bytes", async () => {
    const source = await fixture();
    const other = await fixture();
    await expect(
      encodeModulePackage({
        artifact: source.artifact,
        content: other.content,
        files: other.bytes,
        module: source.module,
        version: other.version,
      })
    ).rejects.toThrow("belongs to another Artifact");
    await expect(
      encodeModulePackage({
        artifact: source.artifact,
        content: source.content,
        files: {
          "outputs/program/server.js": new TextEncoder().encode("tampered"),
        },
        module: source.module,
        version: source.version,
      })
    ).rejects.toThrow("do not match the tree");
  });

  it("rejects an invalid Manifest before persisting", async () => {
    const source = await fixture();
    const tampered = JSON.parse(await encoded(source)) as Envelope;
    tampered.content.manifest.program.entry = "outputs/program/missing.js";
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });

    await expect(
      importPackage(target, canonicalizeJson(tampered))
    ).rejects.toThrow("absent from the Content tree");
    expect(await target.get(source.artifact.id)).toBeNull();
  });

  it("rejects a valid-looking Manifest whose digest no longer matches", async () => {
    const source = await fixture();
    const tampered = JSON.parse(await encoded(source)) as Envelope;
    tampered.content.manifest.capabilities.push({
      alias: "network",
      capability: "host.network.fetch",
      reason: "Fetches data",
      required: false,
      version: 1,
    });
    const target = new ArtifactManager({ store: new InMemoryArtifactStore() });

    await expect(
      importPackage(target, canonicalizeJson(tampered))
    ).rejects.toThrow("Manifest digest mismatch");
    expect(await target.get(source.artifact.id)).toBeNull();
  });

  it("rejects malformed package text and the previous format", async () => {
    await expect(
      importPackage(
        new ArtifactManager({ store: new InMemoryArtifactStore() }),
        "{}"
      )
    ).rejects.toThrow("Unsupported Module Package format");
    await expect(
      importPackage(
        new ArtifactManager({ store: new InMemoryArtifactStore() }),
        canonicalizeJson({ format: "foundry.module/1" })
      )
    ).rejects.toThrow("Unsupported Module Package format");
  });

  it("rolls back the Artifact when Module persistence fails inside the transaction", async () => {
    const source = await fixture();
    const artifacts = new ArtifactManager({
      store: new InMemoryArtifactStore(),
    });
    await expect(
      importModulePackage({
        artifacts,
        encoded: await encoded(source),
        modules: new RejectingModuleStore(),
      })
    ).rejects.toThrow("injected Module persistence failure");
    expect(await artifacts.get(source.artifact.id)).toBeNull();
  });
});
