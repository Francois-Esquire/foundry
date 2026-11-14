import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHUNK_BYTES } from "../constants";
import { ArtifactManager } from "../manager";
import { blobFiles } from "../node";
import { openStore, STORE_KINDS, type StoreKind } from "./helpers/stores";

/** Which step of staging fails next, once. */
const inject: {
  discard?: boolean;
  promotionSync?: boolean;
  stagingSync?: boolean;
} = {};

const STAGED = `${sep}.staging${sep}`;

vi.mock("@foundry/lib/atomic-file", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@foundry/lib/atomic-file")>();
  return {
    ...actual,
    syncDirectory: async (path: string) => {
      if (inject.promotionSync) {
        inject.promotionSync = false;
        throw Object.assign(new Error("EIO: promotion sync failed"), {
          code: "EIO",
        });
      }
      await actual.syncDirectory(path);
    },
    writeFileAtomic: async (
      ...args: Parameters<typeof actual.writeFileAtomic>
    ) => {
      await actual.writeFileAtomic(...args);
      if (inject.stagingSync && args[0].includes(STAGED)) {
        inject.stagingSync = false;
        // The file was renamed into place; syncing its directory failed.
        throw Object.assign(new Error("EIO: staging sync failed"), {
          code: "EIO",
        });
      }
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      const [path, options] = args;
      if (
        inject.discard &&
        String(path).includes(STAGED) &&
        // A staged name, not the temporary an atomic write cleans up.
        !String(path).endsWith(".tmp") &&
        options?.recursive !== true
      ) {
        inject.discard = false;
        return Promise.reject(
          Object.assign(new Error("EIO: discard failed"), { code: "EIO" })
        );
      }
      return actual.rm(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  for (const key of Object.keys(inject) as (keyof typeof inject)[]) {
    inject[key] = false;
  }
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function harness(kind: StoreKind) {
  const root = await mkdtemp(join(tmpdir(), "artifact-staging-failure-"));
  roots.push(root);
  const blobs = join(root, "blobs");
  const store = await openStore(kind);
  const artifacts = new ArtifactManager({ files: blobFiles(blobs), store });
  const staged = async () => {
    const found: string[] = [];
    const area = join(blobs, ".staging");
    for (const owner of await readdir(area).catch(() => [])) {
      found.push(...(await readdir(join(area, owner))));
    }
    return found;
  };
  const published = async () =>
    (await readdir(blobs).catch(() => [])).filter(
      (name) => !name.startsWith(".")
    );
  return { artifacts, published, staged, store };
}

const entries = (bytes: string) => ({ "f.txt": { bytes } });

describe.each(STORE_KINDS)("%s store: Staging that fails part way", (kind) => {
  it("leaves no staged file when the staging directory sync fails after the rename", async () => {
    const { artifacts, published, staged } = await harness(kind);
    inject.stagingSync = true;
    await expect(
      artifacts.create({ entries: entries("x"), name: "A", type: "text/plain" })
    ).rejects.toThrow("staging sync failed");
    expect(await staged()).toEqual([]);
    expect(await published()).toEqual([]);
    expect((await artifacts.list()).total).toBe(0);
  });

  it("leaves no published or staged file when promotion's directory sync fails", async () => {
    const { artifacts, published, staged } = await harness(kind);
    inject.promotionSync = true;
    await expect(
      artifacts.create({ entries: entries("x"), name: "A", type: "text/plain" })
    ).rejects.toThrow("promotion sync failed");
    expect(await published()).toEqual([]);
    expect(await staged()).toEqual([]);
    expect((await artifacts.list()).total).toBe(0);
  });

  it("keeps a change's outcome when discarding its unused staging fails", async () => {
    const { artifacts, published, store } = await harness(kind);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      // Expected: the failed discard is reported, not thrown.
    });
    await artifacts.create({
      entries: entries("same"),
      name: "First",
      type: "text/plain",
    });
    // The second change dedups to the first's blob, so its staged copy goes unused.
    inject.discard = true;
    const second = await artifacts.create({
      entries: entries("same"),
      name: "Second",
      type: "text/plain",
    });
    expect(second.name).toBe("Second");
    expect(logged).toHaveBeenCalledWith(
      "Staged blob cleanup failed",
      expect.objectContaining({ message: "EIO: discard failed" })
    );
    expect(await store.listBlobs()).toHaveLength(1);
    expect(await published()).toHaveLength(1);
  });

  it("keeps a failed change's own error when discarding its staging fails", async () => {
    const { artifacts } = await harness(kind);
    vi.spyOn(console, "error").mockImplementation(() => {
      // Expected: the failed discard is reported, not thrown.
    });
    async function* source() {
      yield new Uint8Array(CHUNK_BYTES);
      inject.discard = true;
      yield await Promise.reject(new Error("source failed"));
    }
    await expect(
      artifacts.create({
        entries: { "f.bin": { source: source() } },
        name: "Broken",
        type: "application/octet-stream",
      })
    ).rejects.toThrow("source failed");
  });
});
