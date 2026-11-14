import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHolder } from "@foundry/lib/file-lock";
import { afterEach, describe, expect, it } from "vitest";

import type { BlobFiles } from "../blob";
import { CHUNK_BYTES } from "../constants";
import { FileTooLargeError, StaleContentError } from "../errors";
import { ArtifactManager } from "../manager";
import { blobFiles, JsonArtifactStore } from "../node";
import type { ArtifactStore } from "../store";
import { InMemoryArtifactStore } from "../store/memory";
import type { Content, FileInput } from "../substrate";
import { interceptCommits } from "../testing";
import { required } from "./helpers/required";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

const text = (value: string) => new TextEncoder().encode(value);
const decoded = (bytes: Uint8Array | undefined) =>
  new TextDecoder().decode(bytes);

/** A whole chunk of `fill`, so staging writes it before the source ends. */
const chunk = (fill: number) => new Uint8Array(CHUNK_BYTES).fill(fill);

/**
 * A source that yields `before`, then waits for `release` before yielding
 * `after`. `waiting` resolves once its reader has taken `before` and asked
 * for more, so whatever it did with `before` is done.
 */
function gated(before: readonly Uint8Array[], after: readonly Uint8Array[]) {
  const waiting = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  async function* source(): AsyncIterable<Uint8Array> {
    yield* before;
    waiting.resolve();
    await released.promise;
    yield* after;
  }
  return {
    release: () => released.resolve(),
    source: source(),
    waiting: waiting.promise,
  };
}

/**
 * How `promise` settled within `ms`: `resolved`, `rejected`, or `pending`,
 * so a call held behind a stalled source fails an assertion, not the suite.
 */
async function within(promise: Promise<unknown>, ms = 1000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        () => "rejected"
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every file waiting in a blob root's staging area. */
async function stagedFiles(blobs: string): Promise<string[]> {
  const root = join(blobs, ".staging");
  const found: string[] = [];
  for (const owner of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, owner)).catch(() => [])) {
      found.push(join(owner, name));
    }
  }
  return found;
}

/** The published blob files of a blob root. */
async function publishedFiles(blobs: string): Promise<string[]> {
  return (await readdir(blobs).catch(() => []))
    .filter((name) => !name.startsWith("."))
    .sort();
}

/** The backing paths the store's records name. */
async function referencedFiles(store: ArtifactStore): Promise<string[]> {
  return (await store.listBlobs())
    .flatMap((blob) => (blob.path ? [blob.path] : []))
    .sort();
}

function file(content: Content | null | undefined, path: string) {
  const entry = required(content).tree[path];
  if (entry?.type !== "file") {
    throw new Error(`Expected file ${path}`);
  }
  return entry;
}

type Kind = "memory" | "json";

/**
 * Storage two managers share: one memory store, or one JSON records file
 * that each manager opens on its own, as two processes would. Every manager
 * gets its own `blobFiles` over one blob root.
 */
async function storage(kind: Kind) {
  const root = await mkdtemp(join(tmpdir(), "artifact-staging-"));
  roots.push(root);
  const blobs = join(root, "blobs");
  const records = join(root, "records.json");
  const memory = new InMemoryArtifactStore();
  const open = (): ArtifactStore =>
    kind === "memory" ? memory : new JsonArtifactStore({ path: records });
  const store = open();
  const manager = (
    options: {
      /** `null` for none: bytes then stay inline in the records. */
      readonly files?: BlobFiles | null;
      readonly maxFileBytes?: number;
      readonly store?: ArtifactStore;
    } = {}
  ) =>
    new ArtifactManager({
      ...(options.files === null
        ? {}
        : { files: options.files ?? blobFiles(blobs) }),
      store: options.store ?? open(),
      ...(options.maxFileBytes === undefined
        ? {}
        : { maxFileBytes: options.maxFileBytes }),
    });
  /** Nothing staged, and exactly the files the records name are published. */
  const settled = async () => {
    expect(await stagedFiles(blobs)).toEqual([]);
    expect(await publishedFiles(blobs)).toEqual(await referencedFiles(store));
  };
  const lockHeld = () =>
    kind === "json" && lockHolder(`${records}.lock`) !== undefined;
  return { blobs, lockHeld, manager, open, settled, store };
}

describe.each(["memory", "json"] as const)(
  "%s store: staged blob bytes",
  (kind) => {
    it("keep a stalled source from holding the store for other managers", async () => {
      const { blobs, lockHeld, manager, settled } = await storage(kind);
      const stalled = manager();
      const other = manager();
      const seed = await other.create({
        entries: { "seed.txt": { bytes: "seed" } },
        name: "Seed",
        type: "text/plain",
      });
      const gate = gated([chunk(1)], [text("tail")]);
      const creating = stalled.create({
        entries: { "big.bin": { source: gate.source } },
        name: "Big",
        type: "application/octet-stream",
      });
      try {
        expect(await within(gate.waiting)).toBe("resolved");
        expect(await stagedFiles(blobs)).toHaveLength(1);
        expect(lockHeld()).toBe(false);
        expect(await within(other.list())).toBe("resolved");
        expect(
          await within(other.readFile(required(seed.contentId), "seed.txt"))
        ).toBe("resolved");
        expect(
          await within(
            other.write({
              artifactId: seed.id,
              changes: { put: { "seed.txt": { bytes: "changed" } } },
            })
          )
        ).toBe("resolved");
      } finally {
        gate.release();
      }
      const created = await creating;
      const read = await stalled.readFileRange(
        required(created.contentId),
        "big.bin",
        { end: CHUNK_BYTES + 4, start: CHUNK_BYTES - 1 }
      );
      const bytes: number[] = [];
      for await (const part of required(read).body) {
        bytes.push(...part);
      }
      expect(bytes).toEqual([1, ...text("tail")]);
      await settled();
    });

    it("refuse a change whose fence moved while its bytes were staged", async () => {
      const { blobs, manager, settled } = await storage(kind);
      const writer = manager();
      const other = manager();
      const seed = await other.create({
        entries: { "file.txt": { bytes: "old" } },
        name: "Fenced",
        type: "text/plain",
      });
      const gate = gated([chunk(2)], [text("mine")]);
      const writing = writer.write({
        artifactId: seed.id,
        changes: { put: { "file.txt": { source: gate.source } } },
        expectedUpdatedAt: required(seed.content).updatedAt,
      });
      try {
        expect(await within(gate.waiting)).toBe("resolved");
        expect(await stagedFiles(blobs)).toHaveLength(1);
        expect(
          await within(
            other.write({
              artifactId: seed.id,
              changes: { put: { "file.txt": { bytes: "theirs" } } },
            })
          )
        ).toBe("resolved");
      } finally {
        gate.release();
      }
      await expect(writing).rejects.toBeInstanceOf(StaleContentError);
      const kept = await other.readFile(required(seed.contentId), "file.txt");
      expect(decoded(kept?.blob)).toBe("theirs");
      await settled();
    });

    it("recompute ownership inside the change: a blob shared meanwhile is not rewritten", async () => {
      const { manager, settled } = await storage(kind);
      const writer = manager();
      const other = manager();
      const seed = await other.create({
        entries: { "file.txt": { bytes: "old" } },
        name: "Owned",
        type: "text/plain",
      });
      const shared = file(seed.content, "file.txt").blobId;
      const gate = gated([], [text("new")]);
      const writing = writer.write({
        artifactId: seed.id,
        changes: { put: { "file.txt": { source: gate.source } } },
      });
      let copy: Awaited<ReturnType<ArtifactManager["create"]>> | undefined;
      try {
        expect(await within(gate.waiting)).toBe("resolved");
        // Another Artifact names the same object while the bytes are staged.
        const copying = other.create({
          entries: { "copy.txt": { blobId: shared } },
          name: "Copy",
          type: "text/plain",
        });
        expect(await within(copying)).toBe("resolved");
        copy = await copying;
      } finally {
        gate.release();
      }
      const written = await writing;
      expect(file(written, "file.txt").blobId).not.toBe(shared);
      expect(file(required(copy).content, "copy.txt").blobId).toBe(shared);
      expect(
        decoded(
          (await other.readFile(required(copy?.contentId), "copy.txt"))?.blob
        )
      ).toBe("old");
      expect(
        decoded((await other.readFile(written.id, "file.txt"))?.blob)
      ).toBe("new");
      await settled();
    });

    it("store identical bytes staged at once by two managers as one blob", async () => {
      const { manager, settled, store } = await storage(kind);
      const first = manager();
      const second = manager();
      const gates = [gated([], [text("same")]), gated([], [text("same")])];
      const creating = [first, second].map((artifacts, index) =>
        artifacts.create({
          entries: { "same.txt": { source: required(gates[index]).source } },
          name: `Same ${String(index)}`,
          type: "text/plain",
        })
      );
      try {
        // Both sources are read before either change commits.
        expect(
          await within(Promise.all(gates.map((gate) => gate.waiting)))
        ).toBe("resolved");
      } finally {
        for (const gate of gates) {
          gate.release();
        }
      }
      const created = await Promise.all(creating);
      const [one, two] = created.map((artifact) =>
        file(artifact.content, "same.txt")
      );
      expect(required(one).blobId).toBe(required(two).blobId);
      expect(await store.listBlobs()).toHaveLength(1);
      expect(await referencedFiles(store)).toHaveLength(1);
      await settled();
    });

    describe("leave no staged file when a change fails", () => {
      /** A source that, after one staged chunk, notes what was staged and fails as `fail` says. */
      function failing(blobs: string, fail: () => Uint8Array) {
        const seen: { staged?: number } = {};
        async function* source(): AsyncIterable<Uint8Array> {
          yield chunk(3);
          seen.staged = (await stagedFiles(blobs)).length;
          yield fail();
        }
        return { seen, source: source() };
      }

      it("on a source error", async () => {
        const { blobs, manager, settled } = await storage(kind);
        const { seen, source } = failing(blobs, () => {
          throw new Error("source failed");
        });
        await expect(
          manager().create({
            entries: { "f.bin": { source } },
            name: "Broken",
            type: "application/octet-stream",
          })
        ).rejects.toThrow("source failed");
        expect(seen.staged).toBe(1);
        await settled();
      });

      it("on an aborted source", async () => {
        const { blobs, manager, settled } = await storage(kind);
        const { seen, source } = failing(blobs, () => {
          throw new DOMException("The source was aborted", "AbortError");
        });
        await expect(
          manager().create({
            entries: { "f.bin": { source } },
            name: "Aborted",
            type: "application/octet-stream",
          })
        ).rejects.toThrow("aborted");
        expect(seen.staged).toBe(1);
        await settled();
      });

      it("on a source past the file limit", async () => {
        const { blobs, manager, settled } = await storage(kind);
        const { seen, source } = failing(blobs, () => text("over"));
        await expect(
          manager({ maxFileBytes: CHUNK_BYTES + 1 }).create({
            entries: { "f.bin": { source } },
            name: "Large",
            type: "application/octet-stream",
          })
        ).rejects.toBeInstanceOf(FileTooLargeError);
        expect(seen.staged).toBe(1);
        await settled();
      });

      it("on a commit that does not land", async () => {
        const { blobs, manager, open, settled } = await storage(kind);
        const refusing = interceptCommits(open(), () =>
          Promise.reject(new Error("commit refused"))
        );
        const { seen, source } = failing(blobs, () => text("end"));
        await expect(
          manager({ store: refusing }).create({
            entries: { "f.bin": { source } },
            name: "Refused",
            type: "application/octet-stream",
          })
        ).rejects.toThrow("commit refused");
        expect(seen.staged).toBe(1);
        await settled();
      });
    });

    it("recover removes staging whose owner is gone and keeps a live owner's", async () => {
      const { blobs, manager, settled } = await storage(kind);
      const artifacts = manager();
      await artifacts.create({
        entries: { "kept.txt": { bytes: "kept" } },
        name: "Kept",
        type: "text/plain",
      });
      // A process that exited, and a restart that was handed this pid again.
      const exited = spawnSync(process.execPath, ["-e", ""]).pid;
      const abandoned = [
        `${String(exited)}-${crypto.randomUUID()}`,
        `${String(process.pid)}-${crypto.randomUUID()}`,
      ];
      for (const owner of abandoned) {
        await mkdir(join(blobs, ".staging", owner), { recursive: true });
        await writeFile(
          join(blobs, ".staging", owner, crypto.randomUUID()),
          "left by a crash"
        );
      }
      // A crash after promotion, before the commit: a file no record names.
      await writeFile(
        join(blobs, crypto.randomUUID()),
        "promoted, never named"
      );
      const live = manager();
      const gate = gated([chunk(4)], [text("live")]);
      const staging = live.create({
        entries: { "live.bin": { source: gate.source } },
        name: "Live",
        type: "application/octet-stream",
      });
      try {
        expect(await within(gate.waiting)).toBe("resolved");
        await artifacts.recover();
        expect(await stagedFiles(blobs)).toHaveLength(1);
        const owners = await readdir(join(blobs, ".staging"));
        for (const owner of abandoned) {
          expect(owners).not.toContain(owner);
        }
      } finally {
        gate.release();
      }
      await staging;
      await settled();
      expect((await artifacts.list()).total).toBe(2);
    });
  }
);

describe("Staged blob bytes", () => {
  it("commit changes without a stream in call order", async () => {
    const { manager } = await storage("memory");
    const artifacts = manager();
    const created = await artifacts.create({
      entries: { "file.bin": { bytes: "start" } },
      name: "Ordered",
      type: "application/octet-stream",
    });
    const large = new Uint8Array(2 * CHUNK_BYTES).fill(5);
    const writes = [large, text("small")].map((bytes) =>
      artifacts.write({
        artifactId: created.id,
        changes: { put: { "file.bin": { bytes } } },
      })
    );
    await Promise.all(writes);
    const final = await artifacts.readFile(
      required(created.contentId),
      "file.bin"
    );
    expect(decoded(final?.blob)).toBe("small");
  });

  it("are never listed, read or removed as published files", async () => {
    const { blobs, manager } = await storage("memory");
    const files = blobFiles(blobs);
    const gate = gated([chunk(6)], []);
    const creating = manager({ files }).create({
      entries: { "big.bin": { source: gate.source } },
      name: "Hidden",
      type: "application/octet-stream",
    });
    try {
      await gate.waiting;
      const [staged] = await stagedFiles(blobs);
      const name = join(".staging", required(staged));
      const listed: string[] = [];
      for await (const path of files.list()) {
        listed.push(path);
      }
      expect(listed).toEqual([]);
      const reading = async () => {
        for await (const _ of files.read(name, { end: 1, start: 0 })) {
          // Nothing: the read is refused before it opens a file.
        }
      };
      await expect(reading()).rejects.toThrow("Invalid blob storage path");
      await expect(files.remove(name)).rejects.toThrow(
        "Invalid blob storage path"
      );
      expect(await stagedFiles(blobs)).toEqual([staged]);
    } finally {
      gate.release();
    }
    await creating;
  });
});

/** `files` without its staging area, as a host's own `BlobFiles` would be. */
function withoutStaging(files: BlobFiles): BlobFiles {
  return {
    list: () => files.list(),
    publish: (bytes) => files.publish(bytes),
    read: (path, range) => files.read(path, range),
    remove: (path) => files.remove(path),
  };
}

describe.each([
  ["inline", "none"],
  ["promoted", "staging"],
  ["published", "plain"],
] as const)("Blob objects with %s chunks", (_, files) => {
  async function harness() {
    const { blobs, manager, store } = await storage("memory");
    const chosen = {
      none: null,
      plain: withoutStaging(blobFiles(blobs)),
      staging: blobFiles(blobs),
    }[files];
    return { artifacts: manager({ files: chosen }), blobs, store };
  }

  const twoChunks = (): FileInput => {
    async function* source() {
      yield await Promise.resolve(chunk(7));
      yield await Promise.resolve(text("rest"));
    }
    return { source: source() };
  };

  for (const grouped of [false, true]) {
    const label = grouped ? "inside a transaction" : "on their own";
    it(`dedup a chunked stream, read across its chunks, and reclaim it, ${label}`, async () => {
      const { artifacts, blobs, store } = await harness();
      const create = (name: string) =>
        grouped
          ? artifacts.transaction((scoped) =>
              scoped.create({
                entries: { "f.bin": twoChunks() },
                name,
                type: "application/octet-stream",
              })
            )
          : artifacts.create({
              entries: { "f.bin": twoChunks() },
              name,
              type: "application/octet-stream",
            });
      const one = await create("One");
      const two = await create("Two");
      expect(file(one.content, "f.bin").blobId).toBe(
        file(two.content, "f.bin").blobId
      );
      // One manifest and its two chunks.
      expect(await store.listBlobs()).toHaveLength(3);
      const range = await artifacts.readFileRange(
        required(two.contentId),
        "f.bin",
        { start: CHUNK_BYTES - 2 }
      );
      const bytes: number[] = [];
      for await (const part of required(range).body) {
        bytes.push(...part);
      }
      expect(bytes).toEqual([7, 7, ...text("rest")]);
      await artifacts.delete(one.id);
      await artifacts.delete(two.id);
      expect(await store.listBlobs()).toEqual([]);
      expect(await publishedFiles(blobs)).toEqual([]);
      expect(await stagedFiles(blobs)).toEqual([]);
    });

    it(`rewrite an owned object in place, ${label}`, async () => {
      const { artifacts, blobs, store } = await harness();
      const created = await artifacts.create({
        entries: { "f.txt": { bytes: "before" } },
        name: "Owned",
        type: "text/plain",
      });
      const put = { put: { "f.txt": { bytes: "after" } } };
      const written = grouped
        ? await artifacts.transaction((scoped) =>
            scoped.write({ artifactId: created.id, changes: put })
          )
        : await artifacts.write({ artifactId: created.id, changes: put });
      expect(file(written, "f.txt").blobId).toBe(
        file(created.content, "f.txt").blobId
      );
      expect(
        decoded((await artifacts.readFile(written.id, "f.txt"))?.blob)
      ).toBe("after");
      expect(await publishedFiles(blobs)).toEqual(await referencedFiles(store));
      expect(await stagedFiles(blobs)).toEqual([]);
    });
  }
});
