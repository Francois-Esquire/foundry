import { promises as real } from "node:fs";
import { join } from "node:path";
import { ArtifactManager, artifactIdSchema } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { tryFileLock } from "@foundry/lib/file-lock";
import { thisProcess } from "@foundry/lib/process-identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  followingCommits,
  HostBoundStoreError,
  keepingLinks,
} from "~/database/artifact-links";
import {
  LinksPlacementError,
  linkName,
  rebuildLinks,
  relinkArtifact,
} from "~/database/links";
import { initializeDatabase } from "~/database/open";
import type { ResourceView } from "~/database/resources";
import { artifactBlobs, workspaceStores } from "~/database/stores";
import { WorkspaceRegistry } from "~/database/workspaces";
import { resourceLinks } from "~/layout";
import { temporaryDirectory } from "./helpers/temporary";

type Hook = (kind: string, path: string) => Promise<void>;
const LAST_DIGIT = /\d(?=\D*$)/;
const hooks: { current: Hook | undefined } = { current: undefined };

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const at = (kind: string, path: unknown) =>
    hooks.current?.(kind, String(path)) ?? Promise.resolve();
  return {
    ...fs,
    lstat: async (path: string) => {
      const found = await fs.lstat(path);
      await at("lstat", path);
      return found;
    },
    mkdir: async (path: string, options?: Parameters<typeof fs.mkdir>[1]) => {
      await at("mkdir", path);
      return fs.mkdir(path, options);
    },
    readdir: async (path: string, options: { withFileTypes: true }) => {
      const found = await fs.readdir(path, options);
      await at("readdir", path);
      return found;
    },
    symlink: async (target: string, path: string) => {
      await at(`symlink:${target}`, path);
      return fs.symlink(target, path);
    },
  };
});

afterEach(() => {
  hooks.current = undefined;
});

async function arranged() {
  const home = await real.realpath(temporaryDirectory("marbles-link-races-"));
  const root = join(home, "root");
  const outside = join(home, "outside");
  const artifacts = join(home, "store");
  await real.mkdir(join(root, ".marbles", "artifacts"), { recursive: true });
  await real.mkdir(outside);
  return { artifacts, home, outside, root };
}

function swapper(path: string, outside: string) {
  let swapped = false;
  return async () => {
    if (swapped) {
      return;
    }
    swapped = true;
    await real.rename(path, `${path}-saved`);
    await real.symlink(outside, path);
  };
}

const note = { id: "note", kind: "artifact", owner: "one" } as const;

describe("links made and removed under a race", () => {
  it("make nothing outside when a checked directory becomes a link before a link is made in it", async () => {
    const { artifacts, outside, root } = await arranged();
    const leaf = join(resourceLinks(root, "artifact"), "note");
    await real.mkdir(leaf);
    const swap = swapper(leaf, outside);
    let checks = 0;
    hooks.current = async (kind, path) => {
      if (kind === "lstat" && path === leaf) {
        checks += 1;
        if (checks === 2) {
          await swap();
        }
      }
    };
    const report = await relinkArtifact({
      artifacts,
      files: [{ blob: "blob", path: "nested/file" }],
      ref: note,
      root,
      workspace: "one",
    });
    expect(report?.refused).toEqual([".marbles/artifacts/note"]);
    expect(await real.readdir(outside)).toEqual([]);
  });

  it("make nothing outside when a directory becomes a link right before one is made in it", async () => {
    const { artifacts, outside, root } = await arranged();
    const dir = resourceLinks(root, "artifact");
    const leaf = join(dir, "note");
    await real.mkdir(leaf);
    const swap = swapper(leaf, outside);
    let made = false;
    hooks.current = async (kind, path) => {
      if (kind === "mkdir" && path === join(leaf, "nested")) {
        await swap();
        made = true;
      }
    };
    const report = await relinkArtifact({
      artifacts,
      files: [{ blob: "blob", path: "nested/file" }],
      ref: note,
      root,
      workspace: "one",
    });
    expect(made).toBe(true);
    expect(report?.refused).toEqual([".marbles/artifacts/note"]);
    expect(await real.readdir(outside)).toEqual([]);
  });

  it("remove nothing outside when a directory listed for pruning becomes a link", async () => {
    const { artifacts, outside, root } = await arranged();
    const dir = resourceLinks(root, "artifact");
    const leaf = join(dir, "note");
    await real.mkdir(leaf);
    await real.symlink(
      join(artifacts, "workspaces", "one", "blobs", "blob"),
      join(outside, "victim")
    );
    const swap = swapper(leaf, outside);
    hooks.current = async (kind, path) => {
      if (kind === "readdir" && path === dir) {
        await swap();
      }
    };
    const report = await rebuildLinks({
      artifacts,
      root,
      view: {
        artifacts: () => Promise.resolve([]),
      } as unknown as ResourceView,
      workspace: "one",
    });
    expect(report.refused).toEqual([".marbles/artifacts/note"]);
    expect(await real.readdir(outside)).toEqual(["victim"]);
  });

  it("wait for the links lock another holder has, and read the files once it has it", async () => {
    const { artifacts, root } = await arranged();
    const held = tryFileLock(join(root, ".marbles", ".lock"));
    if (!("release" in held)) {
      throw new Error("the lock is free");
    }
    let reads = 0;
    let latest = "old";
    const relinking = relinkArtifact({
      artifacts,
      files: () => {
        reads += 1;
        return Promise.resolve([{ blob: latest, path: "f" }]);
      },
      ref: note,
      root,
      workspace: "one",
    });
    await new Promise((settle) => setTimeout(settle, 100));
    expect(reads).toBe(1);
    latest = "new";
    held.release();
    await relinking;
    expect(reads).toBe(2);
    expect(
      await real.readlink(join(resourceLinks(root, "artifact"), "note", "f"))
    ).toBe(join(artifacts, "workspaces", "one", "blobs", "new"));
  });
});

describe("the links lock", () => {
  it("is broken when its holder is gone, a process that had this pid before this one", async () => {
    const { artifacts, root } = await arranged();
    const { started } = thisProcess();
    if (started === null) {
      throw new Error("this process's start is readable here");
    }
    const earlier = started.replace(LAST_DIGIT, (digit) =>
      String((Number(digit) + 1) % 10)
    );
    const lock = join(root, ".marbles", ".lock");
    await real.writeFile(lock, String(process.pid));
    const written = await real.stat(lock);
    await real.writeFile(
      `${lock}.owner`,
      JSON.stringify({
        ctimeMs: written.ctimeMs,
        ino: written.ino,
        pid: process.pid,
        started: earlier,
      })
    );
    await expect(
      relinkArtifact({
        artifacts,
        files: [{ blob: "blob", path: "f" }],
        ref: note,
        root,
        workspace: "one",
      })
    ).resolves.toMatchObject({ linked: 1 });
  });
});

describe("link names", () => {
  it("decode back to the name, and fit no longer than the file system takes", async () => {
    for (const name of ["A", "é", "é", "notes#1", "Ünïcode 🙂", ".."]) {
      expect(decodeURIComponent(linkName(name))).toBe(name);
    }
    const { artifacts, root } = await arranged();
    for (const id of ["a".repeat(256), "A".repeat(90)]) {
      await expect(
        relinkArtifact({
          artifacts,
          files: [{ blob: "blob", path: "f" }],
          ref: { ...note, id },
          root,
          workspace: "one",
        })
      ).resolves.toMatchObject({ linked: 0, unlinkable: 1 });
    }
  });
});

describe("keepers of one workspace's links", () => {
  async function machine() {
    const { artifacts, home, root } = await arranged();
    const state = join(home, "state");
    const opened = await initializeDatabase(join(state, "marbles.db"));
    const { database } = opened;
    await new WorkspaceRegistry({ database, state }).touch(
      { dir: join(state, "one"), id: "one", root },
      null
    );
    return { artifacts, database, opened, root, state };
  }

  it("end on what the database holds when an older keeper is held up while a newer one links", async () => {
    const { artifacts, database, opened, root, state } = await machine();
    try {
      const plain = workspaceStores(database, "one").artifacts;
      const id = artifactIdSchema.parse("item");
      await new ArtifactManager({
        files: blobFiles(artifactBlobs(artifacts, "one")),
        store: plain,
      }).create({
        entries: { f: { bytes: "hello", mime: "text/plain" } },
        id,
        name: "item",
        type: "text/plain",
      });
      const record = await plain.getArtifact(id);
      const contentId = record?.contentId ?? null;
      const content =
        contentId === null ? null : await plain.getContent(contentId);
      const node = content?.tree.f;
      const blob =
        node?.type === "file" ? await plain.getBlob(node.blobId) : null;
      if (blob === null) {
        throw new Error("the item's blob");
      }
      const options = {
        artifacts,
        database,
        owner: "one",
        report: () => undefined,
        state,
      };
      const older = keepingLinks(
        workspaceStores(database, "one").artifacts,
        options
      );
      const newer = keepingLinks(
        workspaceStores(database, "one").artifacts,
        options
      );
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const atOld = new Promise<void>((settle) => {
        reached = settle;
      });
      const released = new Promise<void>((settle) => {
        release = settle;
      });
      hooks.current = async (kind) => {
        if (kind.startsWith("symlink:") && kind.endsWith("/old")) {
          hooks.current = undefined;
          reached();
          await released;
        }
      };
      await older.commit({
        putBlobs: [{ ...blob, path: "old" } as typeof blob],
      });
      await atOld;
      await newer.commit({
        putBlobs: [{ ...blob, path: "new" } as typeof blob],
      });
      const path = join(resourceLinks(root, "artifact"), "item", "f");
      const newLink = join(artifacts, "workspaces", "one", "blobs", "new");
      await vi.waitFor(
        async () => expect(await real.readlink(path)).toBe(newLink),
        { timeout: 10_000 }
      );
      release();
      await vi.waitFor(
        async () => expect(await real.readdir(join(path, ".."))).toEqual(["f"]),
        { timeout: 10_000 }
      );
      expect(await real.readlink(path)).toBe(newLink);
    } finally {
      opened.close();
    }
  });

  it("refuse a store whose commits land only with its host's transaction", async () => {
    const { artifacts, database, opened, state } = await machine();
    try {
      await expect(
        database.transaction(async (tx) => {
          keepingLinks(workspaceStores(tx, "one").artifacts, {
            artifacts,
            database: tx,
            owner: "one",
            report: () => undefined,
            state,
          });
        })
      ).rejects.toThrow(HostBoundStoreError);
    } finally {
      opened.close();
    }
  });

  it("hand on each id a transaction's commits name once", async () => {
    const { database, opened } = await machine();
    try {
      const landed: { artifacts: readonly string[] }[] = [];
      const store = followingCommits(
        workspaceStores(database, "coalesced").artifacts,
        (touched) => landed.push(touched)
      );
      const id = artifactIdSchema.parse("again");
      await store.transaction(async (view) => {
        const artifacts = new ArtifactManager({ store: view });
        await artifacts.create({
          entries: { a: { bytes: "1", mime: "text/plain" } },
          id,
          name: "again",
          type: "text/plain",
        });
        await artifacts.rename(id, "again, renamed");
        await artifacts.rename(id, "again, renamed twice");
      });
      expect(landed).toHaveLength(1);
      expect(landed[0]?.artifacts.filter((each) => each === id)).toEqual([id]);
    } finally {
      opened.close();
    }
  });
});

describe("a relink that ends early", () => {
  async function heldLock(root: string) {
    const held = tryFileLock(join(root, ".marbles", ".lock"));
    if (!("release" in held)) {
      throw new Error("the lock is free");
    }
    return held;
  }

  async function entries(dir: string): Promise<string[]> {
    const found = await real.readdir(dir, { recursive: true });
    return found.map(String).sort();
  }

  async function temporaryLinks(root: string): Promise<string[]> {
    return (await entries(resourceLinks(root, "artifact"))).filter((entry) =>
      entry.endsWith(".link")
    );
  }

  it("touches nothing on disk when it is aborted before it begins", async () => {
    const { artifacts, root } = await arranged();
    await real.rm(join(root, ".marbles", "artifacts"), { recursive: true });
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      relinkArtifact({
        artifacts,
        files: [{ blob: "blob", path: "nested/f" }],
        ref: note,
        root,
        signal: controller.signal,
        workspace: "one",
      })
    ).rejects.toThrow("stopped");
    expect(await real.readdir(join(root, ".marbles"))).toEqual([]);
  });

  it("leaves no temporary link behind when it is aborted waiting for the lock", async () => {
    const { artifacts, root } = await arranged();
    const held = await heldLock(root);
    const controller = new AbortController();
    const relinking = relinkArtifact({
      artifacts,
      files: [{ blob: "blob", path: "nested/f" }],
      ref: note,
      root,
      signal: controller.signal,
      workspace: "one",
    });
    await vi.waitFor(async () =>
      expect(await temporaryLinks(root)).toHaveLength(1)
    );
    controller.abort(new Error("stopped"));
    await expect(relinking).rejects.toThrow("stopped");
    held.release();
    expect(await temporaryLinks(root)).toEqual([]);
  });

  it("keeps another relink's links and the artifacts directory when one is aborted after it prepared", async () => {
    const { artifacts, root } = await arranged();
    await real.rm(resourceLinks(root, "artifact"), { recursive: true });
    const held = await heldLock(root);
    const controller = new AbortController();
    const aborted = relinkArtifact({
      artifacts,
      files: [{ blob: "blob", path: "nested/f" }],
      ref: note,
      root,
      signal: controller.signal,
      workspace: "one",
    });
    const stopped = expect(aborted).rejects.toThrow("stopped");
    await vi.waitFor(async () =>
      expect(await temporaryLinks(root)).toHaveLength(1)
    );
    let reads = 0;
    const other = relinkArtifact({
      artifacts,
      files: async () => {
        reads += 1;
        if (reads === 1) {
          controller.abort(new Error("stopped"));
          await stopped;
          held.release();
        }
        return [{ blob: "blob", path: "g" }];
      },
      ref: { ...note, id: "memo" },
      root,
      workspace: "one",
    });
    await expect(other).resolves.toMatchObject({ linked: 1, refused: [] });
    expect(reads).toBe(2);
    expect(
      await real.readlink(join(resourceLinks(root, "artifact"), "memo", "g"))
    ).toBe(join(artifacts, "workspaces", "one", "blobs", "blob"));
    expect(await temporaryLinks(root)).toEqual([]);
    expect(await entries(resourceLinks(root, "artifact"))).not.toContain(
      join("note", "nested", "f")
    );
  });

  it("leaves no temporary or stale link behind when the files read under the lock are gone", async () => {
    const { artifacts, root } = await arranged();
    const shared = { ...note, owner: "two" };
    await relinkArtifact({
      artifacts,
      files: [{ blob: "blob", path: "f" }],
      ref: shared,
      root,
      workspace: "one",
    });
    expect(await entries(resourceLinks(root, "artifact"))).toEqual([
      "@two",
      join("@two", "note"),
      join("@two", "note", "f"),
    ]);
    let reads = 0;
    await relinkArtifact({
      artifacts,
      files: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1 ? [{ blob: "blob", path: "nested/g" }] : []
        );
      },
      ref: shared,
      root,
      workspace: "one",
    });
    expect(reads).toBe(2);
    expect(await temporaryLinks(root)).toEqual([]);
    expect(await entries(resourceLinks(root, "artifact"))).not.toContain(
      join("@two", "note", "f")
    );
  });

  it("removes the link it made for a rename that failed", async () => {
    const { artifacts, root } = await arranged();
    let reads = 0;
    const rename = vi
      .spyOn(real, "rename")
      .mockRejectedValueOnce(
        Object.assign(new Error("the disk failed"), { code: "EIO" })
      );
    try {
      await expect(
        relinkArtifact({
          artifacts,
          files: () => {
            reads += 1;
            return Promise.resolve([
              { blob: reads === 1 ? "old" : "new", path: "f" },
            ]);
          },
          ref: note,
          root,
          workspace: "one",
        })
      ).rejects.toThrow("the disk failed");
    } finally {
      rename.mockRestore();
    }
    expect(await temporaryLinks(root)).toEqual([]);
  });

  it("takes no lock through a .marbles that became a link after it was opened", async () => {
    const { artifacts, outside, root } = await arranged();
    const top = join(root, ".marbles");
    let reads = 0;
    let strayLock = false;
    let swapped = false;
    hooks.current = async (kind) => {
      if (!swapped && reads === 1 && kind.startsWith("symlink:")) {
        swapped = true;
        await real.rename(top, `${top}-saved`);
        await real.symlink(outside, top);
      }
    };
    await expect(
      relinkArtifact({
        artifacts,
        files: async () => {
          reads += 1;
          strayLock ||= await real
            .lstat(join(outside, ".lock"))
            .then(() => true)
            .catch(() => false);
          return [{ blob: "blob", path: "f" }];
        },
        ref: note,
        root,
        workspace: "one",
      })
    ).rejects.toThrow(LinksPlacementError);
    expect(swapped).toBe(true);
    expect(strayLock).toBe(false);
    expect(reads).toBe(1);
    expect(await real.readdir(outside)).toEqual([]);
  });

  it("keeps an artifacts directory that was there before, when a relink links nothing", async () => {
    const { artifacts, root } = await arranged();
    await expect(
      relinkArtifact({
        artifacts,
        files: [],
        ref: note,
        root,
        workspace: "one",
      })
    ).resolves.toMatchObject({ linked: 0 });
    expect(await real.readdir(resourceLinks(root, "artifact"))).toEqual([]);
  });
});
