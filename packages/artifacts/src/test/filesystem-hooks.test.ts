import { readFileSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { WorkspaceSourceUnavailableError } from "@foundry/workspaces";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactApplicationError } from "../errors";
import { ArtifactManager } from "../manager";
import { InMemoryArtifactStore } from "../memory";
import {
  ARTIFACT_CONFLICTS_DIRECTORY,
  type ArtifactDiskConflict,
  type ArtifactFileMutation,
  artifactFileSystem,
  JsonArtifactStore,
} from "../node";
import type { ContentResolved } from "../substrate";
import { fixture } from "./helpers/directory";
import { required } from "./helpers/required";

const encoder = new TextEncoder();
const STAMP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function text(
  artifacts: ArtifactManager,
  id: string,
  path: string
): Promise<string> {
  const artifact = required(await artifacts.get(id as never));
  const file = await artifacts.readFile(required(artifact.contentId), path);
  return new TextDecoder().decode(required(file).blob);
}

describe("a filesystem bound to a JSON record store", () => {
  it("applies each commit without waiting on its own lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-json-fs-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const artifacts = new ArtifactManager({
      store: new JsonArtifactStore({
        lockTimeoutMs: 2000,
        path: join(root, "artifacts.json"),
      }),
    });
    const filesystem = artifactFileSystem({
      artifacts,
      root: join(root, "files"),
    });
    cleanups.push(() => filesystem.close());
    const created = await artifacts.create({
      entries: { "notes.md": { bytes: encoder.encode("one") } },
      name: "Notes",
      type: "text/markdown",
    });
    const { path } = await filesystem.resolve({ artifactId: created.id });
    await artifacts.write({
      artifactId: created.id,
      changes: { put: { "notes.md": { bytes: encoder.encode("two") } } },
    });
    expect(await readFile(join(path, "notes.md"), "utf8")).toBe("two");
  });
});

describe("selective application", () => {
  it("never mirrors or writes an Artifact it does not include", async () => {
    const { artifacts, filesystem, root, system } = await fixture({}, false, {
      includes: (artifact) => artifact.type !== "application/x-private",
    });
    const hidden = await artifacts.create({
      entries: { "secret.md": { bytes: encoder.encode("hidden") } },
      name: "Private",
      type: "application/x-private",
    });
    await artifacts.write({
      artifactId: hidden.id,
      changes: { put: { "secret.md": { bytes: encoder.encode("still") } } },
    });
    expect(await readdir(root)).not.toContain(hidden.id);
    await expect(system.load({ artifactId: hidden.id })).rejects.toBeInstanceOf(
      WorkspaceSourceUnavailableError
    );
    await expect(
      filesystem.writeFile(
        join(root, hidden.id, "secret.md"),
        encoder.encode("x")
      )
    ).rejects.toBeInstanceOf(WorkspaceSourceUnavailableError);
    expect(await text(artifacts, hidden.id, "secret.md")).toBe("still");
  });
});

describe("mutation hooks", () => {
  it("stamp Content metadata in the same write and see it once committed", async () => {
    const seen: ArtifactFileMutation["kind"][] = [];
    const committed: ContentResolved[] = [];
    const onDisk: string[] = [];
    let directory = "";
    const { artifact, artifacts, load } = await fixture(
      { "notes.md": { bytes: "before" } },
      false,
      {
        mutation: ({ kind }) => {
          seen.push(kind);
          return Promise.resolve({
            committed: (content) => {
              committed.push(content);
              // Committed records are already applied to disk by now.
              onDisk.push(readFileSync(join(directory, "notes.md"), "utf8"));
            },
            metadata: { origin: { actor: kind } },
          });
        },
      }
    );
    const workspace = await load();
    directory = workspace.root;
    const [file] = await workspace.files();
    const read = await workspace.read(required(file).id);
    if (read.kind !== "text") {
      throw new Error("expected text");
    }
    const saved = await workspace.save({
      expectedDigest: read.digest,
      fileId: required(file).id,
      text: "after",
    });
    expect(saved.kind).toBe("saved");
    const current = required(await artifacts.get(artifact.id));
    expect(current.contentId).toBe(artifact.contentId);
    expect(current.content?.metadata).toMatchObject({
      origin: { actor: "edit" },
    });
    expect(committed.map((content) => content.updatedAt)).toEqual([
      current.content?.updatedAt,
    ]);
    expect(onDisk).toEqual(["after"]);
    expect(seen).toEqual(["edit"]);
  });

  it("report no committed Content when the commit fails", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "artifact-commit-fs-"))
    );
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const commit: { fails: boolean } = { fails: false };
    const artifacts = new ArtifactManager({
      store: new InMemoryArtifactStore({
        commit: () =>
          commit.fails
            ? Promise.reject(new Error("commit failed"))
            : Promise.resolve(),
      }),
    });
    const committed: ContentResolved[] = [];
    const filesystem = artifactFileSystem({
      artifacts,
      mutation: () =>
        Promise.resolve({
          committed: (content) => committed.push(content),
        }),
      root,
    });
    cleanups.push(() => filesystem.close());
    const created = await artifacts.create({
      entries: { "notes.md": { bytes: encoder.encode("before") } },
      name: "Notes",
      type: "text/markdown",
    });
    const { path } = await filesystem.resolve({ artifactId: created.id });
    commit.fails = true;
    await expect(
      filesystem.writeFile(join(path, "notes.md"), encoder.encode("after"))
    ).rejects.toThrow("commit failed");
    commit.fails = false;
    expect(committed).toEqual([]);
    expect(await text(artifacts, created.id, "notes.md")).toBe("before");
  });

  it("report committed Content when only applying it failed", async () => {
    const committed: ContentResolved[] = [];
    const { artifact, artifacts, filesystem } = await fixture(
      { "notes.md": { bytes: "before" } },
      false,
      {
        mutation: () =>
          Promise.resolve({
            committed: (content) => committed.push(content),
          }),
      }
    );
    const { path } = await filesystem.resolve({ artifactId: artifact.id });
    const unbind = artifacts.bind(() =>
      Promise.reject(new Error("apply failed"))
    );
    await expect(
      filesystem.writeFile(join(path, "notes.md"), encoder.encode("after"))
    ).rejects.toBeInstanceOf(ArtifactApplicationError);
    unbind();
    expect(committed.map((content) => content.id)).toEqual([
      required(artifact.contentId),
    ]);
    expect(await text(artifacts, artifact.id, "notes.md")).toBe("after");
  });

  it("refuse a write by throwing, committing nothing", async () => {
    const { artifact, artifacts, load } = await fixture(
      { "notes.md": { bytes: "before" } },
      false,
      { mutation: () => Promise.reject(new Error("not allowed")) }
    );
    const workspace = await load();
    const [file] = await workspace.files();
    const read = await workspace.read(required(file).id);
    if (read.kind !== "text") {
      throw new Error("expected text");
    }
    const saved = await workspace.save({
      expectedDigest: read.digest,
      fileId: required(file).id,
      text: "after",
    });
    expect(saved.kind).toBe("failed");
    expect(await text(artifacts, artifact.id, "notes.md")).toBe("before");
    expect(await artifacts.get(artifact.id)).toEqual(artifact);
  });

  it("wrap polled disk edits and stamp them as disk writes", async () => {
    const synchronized: string[] = [];
    const { artifact, artifacts, load } = await fixture(
      { "notes.md": { bytes: "before" } },
      false,
      {
        mutation: ({ kind }) =>
          Promise.resolve({ metadata: { origin: { actor: kind } } }),
        synchronize: async (id, write) => {
          synchronized.push(id);
          await write();
        },
      }
    );
    const workspace = await load();
    await writeFile(join(workspace.root, "notes.md"), "typed on disk");
    await vi.waitFor(
      async () => {
        expect(await text(artifacts, artifact.id, "notes.md")).toBe(
          "typed on disk"
        );
      },
      { timeout: 4000 }
    );
    expect(synchronized).toEqual([artifact.id]);
    expect(
      required(await artifacts.get(artifact.id)).content?.metadata
    ).toMatchObject({ origin: { actor: "disk" } });
  });
});

describe("conflicting disk edits", () => {
  it("are kept aside before a commit replaces them", async () => {
    const conflicts: ArtifactDiskConflict[] = [];
    const { artifact, artifacts, load, root } = await fixture(
      { "notes.md": { bytes: "base" } },
      false,
      {
        conflicted: (kept) => conflicts.push(kept),
        // Hold disk synchronization so the commit lands first.
        synchronize: () => new Promise<void>(() => undefined),
      }
    );
    const workspace = await load();
    await writeFile(join(workspace.root, "notes.md"), "disk edit");
    await artifacts.write({
      artifactId: artifact.id,
      changes: { put: { "notes.md": { bytes: encoder.encode("api edit") } } },
    });
    expect(await readFile(join(workspace.root, "notes.md"), "utf8")).toBe(
      "api edit"
    );
    const [conflict] = conflicts;
    expect(conflict).toMatchObject({
      artifactId: artifact.id,
      paths: ["notes.md"],
    });
    expect(
      required(conflict).directory.startsWith(
        join(root, ARTIFACT_CONFLICTS_DIRECTORY)
      )
    ).toBe(true);
    expect(
      await readFile(join(required(conflict).directory, "notes.md"), "utf8")
    ).toBe("disk edit");
  });

  it("are kept aside when a fenced disk write loses to a newer commit", async () => {
    const conflicts: ArtifactDiskConflict[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { artifact, artifacts, load } = await fixture(
      { "notes.md": { bytes: "base" } },
      false,
      {
        conflicted: (conflict) => conflicts.push(conflict),
        synchronize: async (_id, write) => {
          await held;
          await write();
        },
      }
    );
    const workspace = await load();
    await writeFile(join(workspace.root, "notes.md"), "disk edit");
    // Let a poll pick the edit up and wait inside synchronize.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await artifacts.write({
      artifactId: artifact.id,
      changes: { put: { "notes.md": { bytes: encoder.encode("api edit") } } },
    });
    release();
    await vi.waitFor(() => expect(conflicts).toHaveLength(1), {
      timeout: 4000,
    });
    expect(await text(artifacts, artifact.id, "notes.md")).toBe("api edit");
    expect(
      await readFile(join(required(conflicts[0]).directory, "notes.md"), "utf8")
    ).toBe("disk edit");
  });

  it("left by a previous process are kept before records are applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-restart-fs-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const artifacts = new ArtifactManager({
      store: new JsonArtifactStore({ path: join(root, "artifacts.json") }),
    });
    const before = artifactFileSystem({ artifacts, root: join(root, "files") });
    const created = await artifacts.create({
      entries: { "notes.md": { bytes: encoder.encode("saved") } },
      name: "Notes",
      type: "text/markdown",
    });
    const { path } = await before.resolve({ artifactId: created.id });
    await before.close();
    await writeFile(join(path, "notes.md"), "edited while closed");
    const conflicts: ArtifactDiskConflict[] = [];
    const after = artifactFileSystem({
      artifacts,
      conflicted: (conflict) => conflicts.push(conflict),
      root: join(root, "files"),
    });
    cleanups.push(() => after.close());
    await after.resolve({ artifactId: created.id });
    expect(await readFile(join(path, "notes.md"), "utf8")).toBe("saved");
    expect(
      await readFile(join(required(conflicts[0]).directory, "notes.md"), "utf8")
    ).toBe("edited while closed");
  });

  it("are not found in files a previous process left from a committed version", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-stale-fs-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const artifacts = new ArtifactManager({
      store: new JsonArtifactStore({ path: join(root, "artifacts.json") }),
    });
    const before = artifactFileSystem({ artifacts, root: join(root, "files") });
    const created = await artifacts.create({
      entries: { "notes.md": { bytes: encoder.encode("saved") } },
      name: "Notes",
      type: "text/markdown",
    });
    const { path } = await before.resolve({ artifactId: created.id });
    await before.close();
    // Committed while nothing applied it: disk still holds the prior version.
    await artifacts.revise({
      artifactId: created.id,
      changes: { put: { "notes.md": { bytes: encoder.encode("revised") } } },
      contentId: required(created.contentId),
      expectedUpdatedAt: required(created.content).updatedAt,
    });
    const conflicts: ArtifactDiskConflict[] = [];
    const after = artifactFileSystem({
      artifacts,
      conflicted: (conflict) => conflicts.push(conflict),
      root: join(root, "files"),
    });
    cleanups.push(() => after.close());
    await after.resolve({ artifactId: created.id });
    expect(await readFile(join(path, "notes.md"), "utf8")).toBe("revised");
    expect(conflicts).toEqual([]);
  });

  it("are not found in files a previous process applied before an in-place write it never applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-unapplied-fs-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const artifacts = new ArtifactManager({
      store: new JsonArtifactStore({ path: join(root, "artifacts.json") }),
    });
    const before = artifactFileSystem({ artifacts, root: join(root, "files") });
    const created = await artifacts.create({
      entries: { "notes.md": { bytes: encoder.encode("saved") } },
      name: "Notes",
      type: "text/markdown",
    });
    const { path } = await before.resolve({ artifactId: created.id });
    await before.close();
    // A save of ready Content in place, committed by a process that stopped
    // before applying it: no record holds the bytes disk still has.
    await artifacts.write({
      artifactId: created.id,
      changes: { put: { "notes.md": { bytes: encoder.encode("written") } } },
      expectedContentId: required(created.contentId),
    });
    const conflicts: ArtifactDiskConflict[] = [];
    const after = artifactFileSystem({
      artifacts,
      conflicted: (conflict) => conflicts.push(conflict),
      root: join(root, "files"),
    });
    cleanups.push(() => after.close());
    await after.resolve({ artifactId: created.id });
    expect(await readFile(join(path, "notes.md"), "utf8")).toBe("written");
    expect(conflicts).toEqual([]);
  });

  it("forget what was applied for an Artifact deleted while the filesystem was closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-orphan-note-fs-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const artifacts = new ArtifactManager({
      store: new JsonArtifactStore({ path: join(root, "artifacts.json") }),
    });
    const files = join(root, "files");
    const before = artifactFileSystem({ artifacts, root: files });
    const [kept, deleted] = await Promise.all(
      ["Kept", "Deleted"].map((name) =>
        artifacts.create({
          entries: { "notes.md": { bytes: encoder.encode(name) } },
          name,
          type: "text/markdown",
        })
      )
    );
    await before.resolve({ artifactId: required(kept).id });
    const { path } = await before.resolve({
      artifactId: required(deleted).id,
    });
    await before.close();
    const notes = () => readdir(join(files, ".applied"));
    expect(await notes()).toHaveLength(2);
    // Deleted while closed, its directory with it.
    await artifacts.delete(required(deleted).id);
    await rm(path, { force: true, recursive: true });

    const after = artifactFileSystem({ artifacts, root: files });
    cleanups.push(() => after.close());
    await after.recover();
    expect(await notes()).toEqual([`${required(kept).id}.json`]);
  });

  it("keep a bounded number of uniquely named sets per Artifact", async () => {
    const conflicts: ArtifactDiskConflict[] = [];
    const { artifact, artifacts, load } = await fixture(
      { "notes.md": { bytes: "base" } },
      false,
      {
        conflicted: (kept) => conflicts.push(kept),
        keptConflicts: 2,
        // Hold disk synchronization so each commit lands first.
        synchronize: () => new Promise<void>(() => undefined),
      }
    );
    const workspace = await load();
    for (const round of [1, 2, 3]) {
      await writeFile(join(workspace.root, "notes.md"), `disk edit ${round}`);
      await artifacts.write({
        artifactId: artifact.id,
        changes: {
          put: { "notes.md": { bytes: encoder.encode(`api edit ${round}`) } },
        },
      });
      // Separate rounds by a millisecond so their stamps order by time.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const directories = conflicts.map((conflict) => conflict.directory);
    expect(new Set(directories).size).toBe(3);
    for (const directory of directories) {
      expect(basename(directory)).toMatch(STAMP_NAME);
    }
    const parent = dirname(required(directories[0]));
    expect((await readdir(parent)).sort()).toEqual(
      directories.slice(1).map((directory) => basename(directory))
    );
    expect(
      await readFile(join(required(directories[2]), "notes.md"), "utf8")
    ).toBe("disk edit 3");
  });
});
