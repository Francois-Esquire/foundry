import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { classifyFile } from "../classification";
import { WorkspaceSourceUnavailableError } from "../errors";
import type { WorkspaceExtension } from "../extension";
import { nodeFileSystem } from "../filesystem";
import { InMemoryWorkspaceStore } from "../in-memory-workspace-store";
import type { WorkspaceCtor } from "../instance";
import type { FileCandidate } from "../scanner";
import type { FileContentResult, WriteOutcome } from "../workspace";
import type { StoredFileRecord } from "../workspace-store";
import type { WorkspaceSystem } from "../workspace-system";
import { directorySystem } from "./helpers/directory-system";

/**
 * A second source layer beside the directory one, in memory.
 *
 * Split from `workspace-system.test.ts`, which owns the directory layer and
 * every layer-neutral case. What lives here is the proof that the root is
 * source-blind: a layer this package never heard of registers, claims its
 * own source string, adds through `create`, and every shared operation runs
 * over it from one body. The Artifact-backed layer lives in
 * `@foundry/artifacts`, the package that owns that substrate.
 */

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function makeRoot(
  tree: Record<string, string | Uint8Array>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "foundry-workspace-artifact-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolute = join(root, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
  return await nodeFileSystem.realpath(root);
}

/** The one tree both layers are proven over. */
const TREE = {
  "docs/guide.md": "# guide\n",
  "media/logo.png": new Uint8Array([0x00, 0x50, 0x4e, 0x47]),
  "README.md": "hello\n",
};

type Files = Record<string, string | Uint8Array>;

const FAKE_SOURCE = "fake";

/** In-memory trees keyed by source id, swapped wholesale by `replace`. */
class FakeTrees {
  readonly #trees = new Map<string, Files>();

  seed(files: Files, id = "source-1"): string {
    this.#trees.set(id, files);
    return id;
  }

  replace(id: string, files: Files): void {
    this.#trees.set(id, files);
  }

  remove(id: string): void {
    this.#trees.delete(id);
  }

  require(id: string): Files {
    const files = this.#trees.get(id);
    if (files === undefined) {
      throw new WorkspaceSourceUnavailableError("no such source", {
        issue: "unavailable",
      });
    }
    return files;
  }
}

function WithFake<B extends WorkspaceCtor>(Base: B, trees: FakeTrees) {
  return class extends Base {
    scan(): Promise<readonly FileCandidate[]> {
      const files = trees.require(this.sourceRef());
      return Promise.resolve(
        Object.entries(files).map(([path, value]) => {
          const bytes = encode(value);
          const classification = classifyFile(path);
          return {
            checksum: digest(bytes),
            extension: classification.extension,
            kind: classification.kind,
            mimeType: classification.mimeType,
            name: classification.name,
            path,
            size: bytes.byteLength,
          };
        })
      );
    }

    protected readFile(file: StoredFileRecord): Promise<FileContentResult> {
      const value = trees.require(this.sourceRef())[file.path];
      if (value === undefined) {
        return Promise.resolve({ kind: "stale", reason: "gone" });
      }
      const bytes = encode(value);
      const common = {
        checksum: digest(bytes),
        mimeType: file.mimeType,
        size: bytes.byteLength,
      };
      return Promise.resolve(
        typeof value === "string"
          ? { kind: "text", text: value, ...common }
          : { kind: "binary", ...common }
      );
    }

    protected writeFile(
      file: StoredFileRecord,
      bytes: Uint8Array,
      expectedChecksum: string
    ): Promise<WriteOutcome> {
      const files = trees.require(this.sourceRef());
      const current = files[file.path];
      if (current === undefined) {
        return Promise.resolve({ kind: "stale", reason: "gone" });
      }
      const currentBytes = encode(current);
      if (digest(currentBytes) !== expectedChecksum) {
        return Promise.resolve({
          current: {
            checksum: digest(currentBytes),
            size: currentBytes.byteLength,
            text: new TextDecoder().decode(currentBytes),
          },
          kind: "conflict",
        });
      }
      trees.replace(this.sourceRef(), {
        ...files,
        [file.path]: new TextDecoder().decode(bytes),
      });
      return Promise.resolve({ kind: "written" });
    }

    private sourceRef(): string {
      if (this.source.sourceId === null) {
        throw new Error("no source id");
      }
      return this.source.sourceId;
    }
  };
}

function fake(trees: FakeTrees): WorkspaceExtension {
  return {
    applies: (record) => record.source === FAKE_SOURCE,
    name: "fake",
    wrap: (Base) => WithFake(Base, trees),
  };
}

function addFake(
  system: Pick<WorkspaceSystem, "create">,
  trees: FakeTrees,
  id: string
) {
  trees.require(id);
  return system.create({
    name: "Fixture",
    path: `fake://${id}`,
    source: FAKE_SOURCE,
    sourceId: id,
  });
}

const encode = (value: string | Uint8Array) =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function seed(files: Files = TREE) {
  const trees = new FakeTrees();
  const id = trees.seed(files);
  const store = new InMemoryWorkspaceStore();
  const system = directorySystem({ store }).extend(fake(trees));
  return { add: () => addFake(system, trees, id), id, store, system, trees };
}

describe("create over a registered layer", () => {
  it("commits the Workspace, its address, and its complete catalog", async () => {
    const { id, store, add } = seed();

    const workspace = await add();

    expect(workspace.source).toEqual({
      kind: FAKE_SOURCE,
      path: `fake://${id}`,
      sourceId: id,
    });
    expect(await workspace.summary()).toMatchObject({
      fileCount: 3,
      name: "Fixture",
      sourceKind: FAKE_SOURCE,
    });
    expect(await store.getWorkspace(workspace.id)).toMatchObject({
      path: `fake://${id}`,
      source: FAKE_SOURCE,
      sourceId: id,
    });
    expect((await workspace.files()).map((file) => file.path)).toEqual([
      "README.md",
      "docs/guide.md",
      "media/logo.png",
    ]);
  });

  it("returns the existing Workspace when the same source is added twice", async () => {
    const { system, add } = seed();

    const first = await add();
    const second = await add();

    expect(second).toBe(first);
    expect(await system.list()).toHaveLength(1);
  });

  it("reconciles on a re-add exactly as a re-add of a registered root does", async () => {
    const { trees, id, add } = seed({ "one.md": "1" });
    const first = await add();

    trees.replace(id, { "one.md": "1", "two.md": "2" });
    const second = await add();

    expect(second.id).toBe(first.id);
    expect((await second.summary()).fileCount).toBe(2);
  });

  it("resolves two concurrent adds of one source to a single durable Workspace", async () => {
    const { system, add } = seed();

    const [left, right] = await Promise.all([add(), add()]);

    expect(left.id).toBe(right.id);
    expect(await system.list()).toHaveLength(1);
  });

  it("creates nothing when the first scan fails", async () => {
    const { trees, id, system } = seed();
    trees.remove(id);

    await expect(
      system.create({
        name: "Fixture",
        path: `fake://${id}`,
        source: FAKE_SOURCE,
        sourceId: id,
      })
    ).rejects.toBeInstanceOf(WorkspaceSourceUnavailableError);
    expect(await system.list()).toEqual([]);
  });
});

/**
 * Every operation past add is written once, so it is proven once and run over
 * both layers rather than copied into two describes that could drift.
 */
describe.each([
  {
    layer: "directory",
    open: async () => {
      const root = await makeRoot(TREE);
      const system = directorySystem();
      return { added: await system.add({ path: root }), system };
    },
  },
  {
    layer: "fake",
    open: async () => {
      const { system, add } = seed();
      return { added: await add(), system };
    },
  },
])("shared operations over a $layer Workspace", ({ open }) => {
  it("summarizes, refreshes, lists, reads text and binary, saves, and removes", async () => {
    const { system, added } = await open();

    expect(await added.summary()).toMatchObject({
      fileCount: 3,
      id: added.id,
    });

    const view = await added.refresh();
    expect(view.source).toEqual({ kind: "reconciled" });
    expect(view.files.map((file) => file.path)).toEqual([
      "README.md",
      "docs/guide.md",
      "media/logo.png",
    ]);

    const files = await added.files();
    const text = files.find((file) => file.path === "docs/guide.md");
    const binary = files.find((file) => file.path === "media/logo.png");
    if (!(text && binary)) {
      throw new Error("expected both leaves catalogued");
    }

    expect(await added.read(text.id)).toEqual({
      checksum: text.checksum,
      kind: "text",
      mimeType: "text/markdown",
      size: 8,
      text: "# guide\n",
    });
    expect(await added.read(binary.id)).toEqual({
      checksum: binary.checksum,
      kind: "binary",
      mimeType: "image/png",
      size: 4,
    });

    const saved = await added.save({
      expectedChecksum: text.checksum,
      fileId: text.id,
      text: "# revised\n",
    });
    expect(saved).toMatchObject({ catalog: "current", kind: "saved" });
    expect(await added.read(text.id)).toMatchObject({
      kind: "text",
      text: "# revised\n",
    });

    const conflict = await added.save({
      expectedChecksum: text.checksum,
      fileId: text.id,
      text: "# too late\n",
    });
    expect(conflict).toMatchObject({
      current: { text: "# revised\n" },
      kind: "conflict",
    });

    const refreshed = await added.refresh();
    expect(refreshed.source).toEqual({ kind: "reconciled" });
    expect(refreshed.files.map((file) => file.id)).toEqual(
      files.map((file) => file.id)
    );

    await added.remove();
    expect(await system.list()).toEqual([]);
  });
});

describe("mixed-layer collection", () => {
  it("lists both layers and offers Git to neither more than it has", async () => {
    const root = await makeRoot(TREE);
    const { system, add } = seed();

    const host = await system.add({ path: root });
    const other = await add();

    expect(
      (await system.list()).map((workspace) => workspace.source.kind).sort()
    ).toEqual([FAKE_SOURCE, "host"]);
    expect(other).not.toHaveProperty("git");
    expect(host).not.toHaveProperty("git");
  });
});

describe("a layered Workspace follows its source", () => {
  it("reconciles onto whatever the layer scans at that moment", async () => {
    const { trees, id, add } = seed({ "dropped.md": "d", "kept.md": "first" });
    const added = await add();

    trees.replace(id, { "kept.md": "second", "new.md": "hi" });
    const view = await added.refresh();

    expect(view.source).toEqual({ kind: "reconciled" });
    expect(view.files.map((file) => file.path)).toEqual(["kept.md", "new.md"]);
  });

  it("keeps the prior catalog and reports unavailable once the source is gone", async () => {
    const { trees, id, add } = seed();
    const added = await add();

    trees.remove(id);
    const view = await added.refresh();

    expect(view.source.kind).toBe("unavailable");
    expect(view.workspace.fileCount).toBe(3);
    expect(view.files.map((file) => file.path)).toEqual([
      "README.md",
      "docs/guide.md",
      "media/logo.png",
    ]);
  });
});
