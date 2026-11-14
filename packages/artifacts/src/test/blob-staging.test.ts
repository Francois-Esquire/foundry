import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHolder } from "@foundry/lib/file-lock";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BlobFiles } from "../blob";
import { MAX_STAGING_STREAMS } from "../blob-staging";
import { CHUNK_BYTES } from "../constants";
import {
  ArtifactNotFoundError,
  ContentNotFoundError,
  ContentStateError,
  FileTooLargeError,
  InvalidArtifactInputError,
  StaleContentError,
} from "../errors";
import { ArtifactManager } from "../manager";
import { blobFiles, JsonArtifactStore } from "../node";
import { STAGING_ABANDONED_AFTER_MS } from "../node/staging";
import type { ContentId } from "../ref";
import { artifactIdSchema, blobIdSchema, contentIdSchema } from "../ref";
import type { ArtifactStore } from "../store";
import { InMemoryArtifactStore } from "../store/memory";
import type { ArtifactResolved, Content, FileInput } from "../substrate";
import { interceptCommits } from "../testing";
import { required } from "./helpers/required";
import { openStore, STORE_KINDS, type StoreKind } from "./helpers/stores";

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

const HOUR = 60 * 60 * 1000;

/** Sets a path's modification time `ms` into the past. */
async function age(path: string, ms: number): Promise<void> {
  const then = new Date(Date.now() - ms);
  await utimes(path, then, then);
}

/** Staging of an owner outside this process, holding one file, last changed `ms` ago. */
async function ownerDirectory(blobs: string, ms: number): Promise<string> {
  const owner = crypto.randomUUID();
  const directory = join(blobs, ".staging", owner);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, crypto.randomUUID()), "staged elsewhere");
  await age(directory, ms);
  return owner;
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

/**
 * Storage two managers share: one memory or SQLite store, or one JSON
 * records file that each manager opens on its own, as two processes would.
 * Every manager gets its own `blobFiles` over one blob root.
 */
async function storage(kind: StoreKind) {
  const root = await mkdtemp(join(tmpdir(), "artifact-staging-"));
  roots.push(root);
  const blobs = join(root, "blobs");
  const records = join(root, "records.json");
  const shared = kind === "json" ? undefined : await openStore(kind);
  const open = (): ArtifactStore =>
    shared ?? new JsonArtifactStore({ path: records });
  const store = open();
  const manager = (
    options: {
      /** `null` for none: bytes then stay inline in the records. */
      readonly files?: BlobFiles | null;
      readonly maxFileBytes?: number;
      readonly maxTreeBytes?: number;
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
      ...(options.maxTreeBytes === undefined
        ? {}
        : { maxTreeBytes: options.maxTreeBytes }),
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

describe.each(STORE_KINDS)("%s store: staged blob bytes", (kind) => {
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
      expect(await within(stalled.list())).toBe("resolved");
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

  it("refuse a change whose object became shared while its bytes were staged", async () => {
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
    await expect(writing).rejects.toBeInstanceOf(StaleContentError);
    const kept = await other.get(seed.id);
    expect(file(kept?.content, "file.txt").blobId).toBe(shared);
    expect(
      decoded(
        (await other.readFile(required(copy?.contentId), "copy.txt"))?.blob
      )
    ).toBe("old");
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
      expect(await within(Promise.all(gates.map((gate) => gate.waiting)))).toBe(
        "resolved"
      );
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

  it("recover removes staging left unchanged past the age, and keeps fresh and live staging", async () => {
    const { blobs, manager, store } = await storage(kind);
    const artifacts = manager();
    await artifacts.create({
      entries: { "kept.txt": { bytes: "kept" } },
      name: "Kept",
      type: "text/plain",
    });
    const old = await ownerDirectory(blobs, STAGING_ABANDONED_AFTER_MS + HOUR);
    // Another process's staging, written a moment ago.
    const fresh = await ownerDirectory(blobs, 0);
    // A crash after promotion, before the commit: a file no record names.
    await writeFile(join(blobs, crypto.randomUUID()), "promoted, never named");
    const live = manager();
    const gate = gated([chunk(4)], [text("live")]);
    const staging = live.create({
      entries: { "live.bin": { source: gate.source } },
      name: "Live",
      type: "application/octet-stream",
    });
    try {
      expect(await within(gate.waiting)).toBe("resolved");
      // The live change's staging: the directory holding its staged chunk.
      const own = required(
        (await stagedFiles(blobs))
          .map((path) => path.split("/")[0])
          .find((name) => name !== fresh)
      );
      // Older than the age, but its owner runs in this process.
      await age(
        join(blobs, ".staging", own),
        STAGING_ABANDONED_AFTER_MS + HOUR
      );
      await artifacts.recover();
      const owners = await readdir(join(blobs, ".staging"));
      expect(owners).not.toContain(old);
      expect(owners).toEqual(expect.arrayContaining([fresh, own]));
      expect(await stagedFiles(blobs)).toHaveLength(2);
    } finally {
      gate.release();
    }
    await staging;
    expect(await stagedFiles(blobs)).toEqual([
      expect.stringMatching(new RegExp(`^${fresh}`)),
    ]);
    expect(await publishedFiles(blobs)).toEqual(await referencedFiles(store));
    expect((await artifacts.list()).total).toBe(2);
  });
});

describe.each(STORE_KINDS)("%s store: Staged blob bytes", (kind) => {
  it("commit changes without a stream in call order", async () => {
    const { manager } = await storage(kind);
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
    const { blobs, manager } = await storage(kind);
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

describe.each(
  STORE_KINDS.flatMap((kind) =>
    (
      [
        ["inline", "none"],
        ["promoted", "staging"],
        ["published", "plain"],
      ] as const
    ).map(([chunks, files]) => [chunks, files, kind] as const)
  )
)("Blob objects with %s chunks (%s files, %s store)", (_, files, kind) => {
  async function harness() {
    const { blobs, manager, store } = await storage(kind);
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

describe.each(STORE_KINDS)("%s store: more staged inputs", (kind) => {
  it("take in every stream of one call before the change, the last one stalled", async () => {
    const { blobs, manager, settled } = await storage(kind);
    const stalled = manager();
    const other = manager();
    const free = gated([text("free")], []);
    free.release();
    const gate = gated([chunk(8)], [text("last")]);
    const creating = stalled.create({
      entries: {
        "a.txt": { source: free.source },
        "b.bin": { source: gate.source },
      },
      name: "Two streams",
      type: "application/octet-stream",
    });
    try {
      expect(await within(gate.waiting)).toBe("resolved");
      expect(await stagedFiles(blobs)).toHaveLength(2);
      expect(await within(other.list())).toBe("resolved");
    } finally {
      gate.release();
    }
    const created = await creating;
    const a = await stalled.readFile(required(created.contentId), "a.txt");
    expect(decoded(a?.blob)).toBe("free");
    await settled();
  });

  it("take a revision's stream in before the change", async () => {
    const { manager, settled } = await storage(kind);
    const reviser = manager();
    const other = manager();
    const seed = await other.create({
      entries: { "file.txt": { bytes: "first" } },
      name: "Revised",
      type: "text/plain",
    });
    const source = required(seed.content);
    const gate = gated([], [text("second")]);
    const revising = reviser.revise({
      artifactId: seed.id,
      changes: { put: { "file.txt": { source: gate.source } } },
      contentId: source.id,
      expectedUpdatedAt: source.updatedAt,
    });
    try {
      expect(await within(gate.waiting)).toBe("resolved");
      expect(await within(other.list())).toBe("resolved");
    } finally {
      gate.release();
    }
    const revised = await revising;
    const read = await other.readFile(revised.id, "file.txt");
    expect(decoded(read?.blob)).toBe("second");
    await settled();
  });

  it("leave no staged file when the tree limit refuses it", async () => {
    const { blobs, manager, settled } = await storage(kind);
    const seen: { staged?: number } = {};
    async function* source(): AsyncIterable<Uint8Array> {
      yield chunk(10);
      seen.staged = (await stagedFiles(blobs)).length;
      yield text("over");
    }
    await expect(
      manager({ maxTreeBytes: CHUNK_BYTES }).create({
        entries: { "f.bin": { source: source() } },
        name: "Tree",
        type: "application/octet-stream",
      })
    ).rejects.toBeInstanceOf(FileTooLargeError);
    expect(seen.staged).toBe(1);
    await settled();
  });
});

describe.each(STORE_KINDS)(
  "%s store: Staged blob bytes without files, and refusals ahead of them",
  (kind) => {
    it("keep a stalled source from holding a store without files", async () => {
      const { manager, store } = await storage(kind);
      const stalled = manager({ files: null });
      const other = manager({ files: null });
      const gate = gated([chunk(9)], [text("inline")]);
      const creating = stalled.create({
        entries: { "big.bin": { source: gate.source } },
        name: "Inline",
        type: "application/octet-stream",
      });
      try {
        expect(await within(gate.waiting)).toBe("resolved");
        expect(await within(other.list())).toBe("resolved");
        expect(
          await within(other.create({ name: "Other", type: "text/plain" }))
        ).toBe("resolved");
      } finally {
        gate.release();
      }
      await creating;
      expect(await referencedFiles(store)).toEqual([]);
      expect((await other.list()).total).toBe(2);
    });

    it("refuse what a change refuses before reading a byte, ahead of the byte limits", async () => {
      const { manager } = await storage(kind);
      const artifacts = manager({ maxFileBytes: 4 });
      await expect(
        artifacts.write({
          artifactId: artifactIdSchema.parse(crypto.randomUUID()),
          changes: { put: { "f.txt": { bytes: "far too long" } } },
        })
      ).rejects.toBeInstanceOf(ArtifactNotFoundError);
      const created = await artifacts.create({
        name: "Fenced",
        type: "text/plain",
      });
      let pulled = false;
      async function* source() {
        pulled = true;
        yield await Promise.resolve(text("never read"));
      }
      await expect(
        artifacts.write({
          artifactId: created.id,
          changes: { put: { "f.txt": { source: source() } } },
          expectedContentId: contentIdSchema.parse(crypto.randomUUID()),
        })
      ).rejects.toBeInstanceOf(StaleContentError);
      expect(pulled).toBe(false);
    });
  }
);

describe.each(STORE_KINDS)("%s store: Staging another owner left", (kind) => {
  it("is removed past the age when an instance first stages, without recover", async () => {
    const { blobs, manager } = await storage(kind);
    const old = await ownerDirectory(blobs, STAGING_ABANDONED_AFTER_MS + HOUR);
    const fresh = await ownerDirectory(blobs, 0);
    await manager().create({
      entries: { "f.txt": { bytes: "fresh" } },
      name: "Fresh",
      type: "text/plain",
    });
    const owners = await readdir(join(blobs, ".staging"));
    expect(owners).not.toContain(old);
    expect(owners).toContain(fresh);
  });
});

describe.each(STORE_KINDS)(
  "%s store: A reference to a missing blob",
  (kind) => {
    /** A source that notes whether it was ever read. */
    function watched(fail?: () => never) {
      const read = { pulled: false };
      async function* source(): AsyncIterable<Uint8Array> {
        read.pulled = true;
        if (fail) {
          fail();
        }
        yield await new Promise<Uint8Array>(() => {
          // Never yields: a stalled source.
        });
      }
      return { read, source: source() };
    }
    const missingBlob = () => ({
      blobId: blobIdSchema.parse(crypto.randomUUID()),
    });

    it("refuses a change before its stalled stream is read", async () => {
      const { manager } = await storage(kind);
      const { read, source } = watched();
      const creating = manager().create({
        entries: { "a.bin": { source }, "b.txt": missingBlob() },
        name: "Missing",
        type: "application/octet-stream",
      });
      expect(await within(creating)).toBe("rejected");
      await expect(creating).rejects.toBeInstanceOf(InvalidArtifactInputError);
      expect(read.pulled).toBe(false);
    });

    it("wins over a source error and a byte limit", async () => {
      const { manager } = await storage(kind);
      const artifacts = manager({ maxFileBytes: 4 });
      const created = await artifacts.create({
        name: "Target",
        type: "text/plain",
      });
      const { read, source } = watched(() => {
        throw new Error("source failed");
      });
      await expect(
        artifacts.write({
          artifactId: created.id,
          changes: { put: { "a.bin": { source }, "b.txt": missingBlob() } },
        })
      ).rejects.toBeInstanceOf(InvalidArtifactInputError);
      expect(read.pulled).toBe(false);
      await expect(
        artifacts.write({
          artifactId: created.id,
          changes: {
            put: {
              "a.txt": { bytes: "far too long" },
              "b.txt": { bytes: 3, digest: "0".repeat(64) },
            },
          },
        })
      ).rejects.toBeInstanceOf(InvalidArtifactInputError);
    });
  }
);

describe.each(STORE_KINDS)("%s store: call order per Artifact", (kind) => {
  it("checks a stream write after a create queued before it", async () => {
    const { manager } = await storage(kind);
    const artifacts = manager();
    const id = artifactIdSchema.parse(crypto.randomUUID());
    async function* source() {
      yield await Promise.resolve(text("streamed"));
    }
    const creating = artifacts.create({
      id,
      name: "Ordered",
      type: "text/plain",
    });
    const writing = artifacts.write({
      artifactId: id,
      changes: { put: { "f.txt": { source: source() } } },
    });
    await creating;
    const written = await writing;
    const read = await artifacts.readFile(written.id, "f.txt");
    expect(decoded(read?.blob)).toBe("streamed");
  });

  it("commits a later write to the same Artifact after an earlier stalled stream", async () => {
    const { manager } = await storage(kind);
    const artifacts = manager();
    const created = await artifacts.create({
      entries: { "f.txt": { bytes: "start" } },
      name: "Ordered",
      type: "text/plain",
    });
    const other = await artifacts.create({
      name: "Other",
      type: "text/plain",
    });
    const gate = gated([], [text("earlier")]);
    const streaming = artifacts.write({
      artifactId: created.id,
      changes: { put: { "f.txt": { source: gate.source } } },
    });
    let later: Promise<unknown> | undefined;
    try {
      expect(await within(gate.waiting)).toBe("resolved");
      later = artifacts.write({
        artifactId: created.id,
        changes: { put: { "f.txt": { bytes: "later" } } },
      });
      // Held behind the stream on its Artifact, and only there.
      expect(await within(later, 200)).toBe("pending");
      expect(
        await within(
          artifacts.write({
            artifactId: other.id,
            changes: { put: { "g.txt": { bytes: "elsewhere" } } },
          })
        )
      ).toBe("resolved");
      expect(await within(artifacts.list())).toBe("resolved");
    } finally {
      gate.release();
    }
    await streaming;
    await later;
    const read = await artifacts.readFile(required(created.contentId), "f.txt");
    expect(decoded(read?.blob)).toBe("later");
  });
});

describe.each(STORE_KINDS)("%s store: Staging bounds", (kind) => {
  it("refuses a change once its staged bytes alone exceed the tree limit, before later streams end", async () => {
    const { blobs, manager } = await storage(kind);
    const artifacts = manager({ maxTreeBytes: CHUNK_BYTES });
    const stalled = gated([text("over")], []);
    try {
      const creating = artifacts.create({
        entries: {
          "a.bin": { bytes: chunk(11) },
          "b.bin": { source: stalled.source },
        },
        name: "Too big",
        type: "application/octet-stream",
      });
      expect(await within(creating)).toBe("rejected");
      await expect(creating).rejects.toBeInstanceOf(FileTooLargeError);
      expect(await stagedFiles(blobs)).toEqual([]);
    } finally {
      stalled.release();
    }
  });

  it("reads at most MAX_STAGING_STREAMS streams of one manager at once", async () => {
    const { manager } = await storage(kind);
    const artifacts = manager();
    const gates = Array.from({ length: MAX_STAGING_STREAMS + 1 }, () =>
      gated([], [text("x")])
    );
    const opened = gates.map(() => false);
    gates.forEach((gate, index) => {
      gate.waiting.then(() => {
        opened[index] = true;
      });
    });
    const creating = gates.map((gate, index) =>
      artifacts.create({
        entries: { "f.txt": { source: gate.source } },
        name: `Stream ${String(index)}`,
        type: "text/plain",
      })
    );
    try {
      await Promise.all(
        gates.slice(0, MAX_STAGING_STREAMS).map((g) => g.waiting)
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(opened.filter(Boolean)).toHaveLength(MAX_STAGING_STREAMS);
      required(gates[0]).release();
      expect(await within(required(gates.at(-1)).waiting)).toBe("resolved");
    } finally {
      for (const gate of gates) {
        gate.release();
      }
    }
    await Promise.all(creating);
    expect((await artifacts.list()).total).toBe(MAX_STAGING_STREAMS + 1);
  });
});

describe.each(STORE_KINDS)(
  "%s store: Ownership checks inside one transaction",
  (kind) => {
    it("let several in-place writes to the same path commit together", async () => {
      const { manager } = await storage(kind);
      const artifacts = manager();
      const [a, b] = await Promise.all(
        ["A", "B"].map((name) =>
          artifacts.create({
            entries: { "f.txt": { bytes: `${name} before` } },
            name,
            type: "text/plain",
          })
        )
      );
      const put = (bytes: string) => ({ put: { "f.txt": { bytes } } });
      await artifacts.transaction(async (scoped) => {
        await scoped.write({
          artifactId: required(a).id,
          changes: put("A after"),
        });
        await scoped.write({
          artifactId: required(b).id,
          changes: put("B after"),
        });
        await scoped.write({
          artifactId: required(a).id,
          changes: put("A again"),
        });
      });
      const read = async (id: ContentId) =>
        decoded((await artifacts.readFile(id, "f.txt"))?.blob);
      expect(await read(required(required(a).contentId))).toBe("A again");
      expect(await read(required(required(b).contentId))).toBe("B after");
    });
  }
);

describe.each(STORE_KINDS)(
  "%s store: Call order for changes named by Content",
  (kind) => {
    it("holds freeze and tag of an Artifact's Content behind its earlier stalled stream", async () => {
      const { manager } = await storage(kind);
      const artifacts = manager();
      const created = await artifacts.create({
        entries: { "f.txt": { bytes: "start" } },
        name: "Frozen later",
        type: "text/plain",
      });
      const contentId = required(created.contentId);
      const gate = gated([], [text("streamed")]);
      const streaming = artifacts.write({
        artifactId: created.id,
        changes: { put: { "f.txt": { source: gate.source } } },
      });
      let later: Promise<unknown> | undefined;
      try {
        expect(await within(gate.waiting)).toBe("resolved");
        later = Promise.all([
          artifacts.tag(contentId, "v1"),
          artifacts.freeze(contentId),
        ]);
        expect(await within(later, 200)).toBe("pending");
      } finally {
        gate.release();
      }
      await streaming;
      await later;
      const content = await artifacts.getContent(contentId);
      expect(content?.state).toBe("frozen");
      expect(content?.tag).toBe("v1");
      const read = await artifacts.readFile(contentId, "f.txt");
      expect(decoded(read?.blob)).toBe("streamed");
    });
  }
);

describe.each(STORE_KINDS)("%s store: ordering turns", (kind) => {
  it("releases a streamed change's turn before its bindings run", async () => {
    const { manager } = await storage(kind);
    const artifacts = manager();
    const created = await artifacts.create({
      entries: { "f.txt": { bytes: "start" } },
      name: "Bound",
      type: "text/plain",
    });
    const renamed: Promise<unknown>[] = [];
    const unbind = artifacts.bind(async (id) => {
      unbind();
      const renaming = artifacts.rename(id, "bound");
      renamed.push(renaming);
      await renaming;
    });
    async function* source() {
      yield await Promise.resolve(text("streamed"));
    }
    const writing = artifacts.write({
      artifactId: created.id,
      changes: { put: { "f.txt": { source: source() } } },
    });
    expect(await within(writing)).toBe("resolved");
    expect(await within(Promise.all(renamed))).toBe("resolved");
    expect((await artifacts.get(created.id))?.name).toBe("bound");
  });
});

describe.each(STORE_KINDS)(
  "%s store: Content-named changes reserve their place",
  (kind) => {
    it("keeps a freeze ahead of a later write to its Artifact", async () => {
      const { manager } = await storage(kind);
      const artifacts = manager();
      const created = await artifacts.create({
        entries: { "f.txt": { bytes: "start" } },
        name: "Reserved",
        type: "text/plain",
      });
      const contentId = required(created.contentId);
      const gate = gated([], [text("streamed")]);
      const streaming = artifacts.write({
        artifactId: created.id,
        changes: { put: { "f.txt": { source: gate.source } } },
      });
      let freezing: Promise<unknown> | undefined;
      let later: Promise<unknown> | undefined;
      try {
        expect(await within(gate.waiting)).toBe("resolved");
        freezing = artifacts.freeze(contentId);
        later = artifacts.write({
          artifactId: created.id,
          changes: { put: { "f.txt": { bytes: "later" } } },
        });
        later.catch(() => undefined);
      } finally {
        gate.release();
      }
      await streaming;
      await freezing;
      await expect(later).rejects.toBeInstanceOf(ContentStateError);
      const content = await artifacts.getContent(contentId);
      expect(content?.state).toBe("frozen");
      expect(
        decoded((await artifacts.readFile(contentId, "f.txt"))?.blob)
      ).toBe("streamed");
    });
  }
);

/** A memory store whose next outer `getContent` fails, once. */
class FailingLookups extends InMemoryArtifactStore {
  failNext: boolean;

  constructor() {
    super();
    this.failNext = false;
  }

  override getContent(id: ContentId): Promise<Content | null> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("lookup failed"));
    }
    return super.getContent(id);
  }
}

describe("A Content-named change's reservation", () => {
  async function pending(store: ArtifactStore) {
    const artifacts = new ArtifactManager({ store });
    const [streamed, other] = await Promise.all(
      ["Streamed", "Other"].map((name) =>
        artifacts.create({
          entries: { "f.txt": { bytes: name } },
          name,
          type: "text/plain",
        })
      )
    );
    const gate = gated([], [text("streamed")]);
    const streaming = artifacts.write({
      artifactId: required(streamed).id,
      changes: { put: { "f.txt": { source: gate.source } } },
    });
    await gate.waiting;
    return {
      artifacts,
      gate,
      other: required(other),
      streamed: required(streamed),
      streaming,
    };
  }

  it("is released when its lookup fails, so later changes proceed", async () => {
    const store = new FailingLookups();
    const { artifacts, gate, other, streamed, streaming } =
      await pending(store);
    try {
      store.failNext = true;
      await expect(
        artifacts.tag(required(streamed.contentId), "v1")
      ).rejects.toThrow("lookup failed");
      expect(
        await within(artifacts.rename(other.id, "renamed while stalled"))
      ).toBe("resolved");
    } finally {
      gate.release();
    }
    await streaming;
    expect(await within(artifacts.rename(streamed.id, "after"))).toBe(
      "resolved"
    );
  });

  it("is released when its lookup finds no Content, so later changes proceed", async () => {
    const { artifacts, gate, other, streaming } = await pending(
      new InMemoryArtifactStore()
    );
    try {
      await expect(
        artifacts.tag(contentIdSchema.parse(crypto.randomUUID()), "v1")
      ).rejects.toBeInstanceOf(ContentNotFoundError);
      expect(
        await within(artifacts.rename(other.id, "renamed while stalled"))
      ).toBe("resolved");
    } finally {
      gate.release();
    }
    await streaming;
  });

  it("is not taken, and nothing is read for it, when no stream is pending", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
    const created = await artifacts.create({
      entries: { "f.txt": { bytes: "x" } },
      name: "Idle",
      type: "text/plain",
    });
    const reads = vi.spyOn(store, "getContent");
    await artifacts.freeze(required(created.contentId));
    expect(reads).not.toHaveBeenCalled();
  });
});

describe.each(STORE_KINDS)("%s store: ordering re-checks", (kind) => {
  async function seeded(name = "Ordered") {
    const { manager } = await storage(kind);
    const artifacts = manager();
    const created = await artifacts.create({
      entries: { "f.txt": { bytes: "start" } },
      name,
      type: "text/plain",
    });
    return { artifacts, created };
  }
  const later = (artifacts: ArtifactManager, id: ArtifactResolved["id"]) =>
    within(
      artifacts.write({
        artifactId: id,
        changes: { put: { "f.txt": { bytes: "after" } } },
      })
    );

  it("releases a stream change's place when it is refused", async () => {
    const { artifacts, created } = await seeded();
    async function* source() {
      yield await Promise.resolve(text("never"));
    }
    await expect(
      artifacts.write({
        artifactId: created.id,
        changes: { put: { "f.txt": { source: source() } } },
        expectedContentId: contentIdSchema.parse(crypto.randomUUID()),
      })
    ).rejects.toBeInstanceOf(StaleContentError);
    expect(await later(artifacts, created.id)).toBe("resolved");
  });

  it("releases a stream change's place when its source errors", async () => {
    const { artifacts, created } = await seeded();
    async function* source(): AsyncIterable<Uint8Array> {
      yield text("part");
      throw new Error("source failed");
    }
    await expect(
      artifacts.write({
        artifactId: created.id,
        changes: { put: { "f.txt": { source: source() } } },
      })
    ).rejects.toThrow("source failed");
    expect(await later(artifacts, created.id)).toBe("resolved");
  });

  it("releases a stream change's place when its source closes early", async () => {
    const { artifacts, created } = await seeded();
    async function* source(): AsyncIterable<Uint8Array> {
      yield text("short");
    }
    await expect(
      artifacts.write({
        artifactId: created.id,
        changes: { put: { "f.txt": { bytes: 64, source: source() } } },
      })
    ).rejects.toBeInstanceOf(InvalidArtifactInputError);
    expect(await later(artifacts, created.id)).toBe("resolved");
  });

  it("settles two stream changes to one Artifact in call order", async () => {
    const { artifacts, created } = await seeded();
    const first = gated([], [text("first")]);
    const second = gated([], [text("second")]);
    const settled: string[] = [];
    const writes = [first, second].map((gate, index) =>
      artifacts
        .write({
          artifactId: created.id,
          changes: { put: { "f.txt": { source: gate.source } } },
        })
        .then(() => {
          settled.push(index === 0 ? "first" : "second");
        })
    );
    await first.waiting;
    // The second is released first; it still commits after the first.
    second.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toEqual([]);
    first.release();
    await Promise.all(writes);
    expect(settled).toEqual(["first", "second"]);
    const read = await artifacts.readFile(required(created.contentId), "f.txt");
    expect(decoded(read?.blob)).toBe("second");
  });

  it("does not hold other Artifacts while a stream waits for a staging turn", async () => {
    const { artifacts, created: other } = await seeded("Other");
    const gates = Array.from({ length: MAX_STAGING_STREAMS + 1 }, () =>
      gated([], [text("x")])
    );
    const creating = gates.map((gate, index) =>
      artifacts.create({
        entries: { "f.txt": { source: gate.source } },
        id: artifactIdSchema.parse(crypto.randomUUID()),
        name: `Stream ${String(index)}`,
        type: "text/plain",
      })
    );
    try {
      await Promise.all(
        gates.slice(0, MAX_STAGING_STREAMS).map((g) => g.waiting)
      );
      expect(await later(artifacts, other.id)).toBe("resolved");
      expect(
        await within(artifacts.tag(required(other.contentId), "elsewhere"))
      ).toBe("resolved");
    } finally {
      for (const gate of gates) {
        gate.release();
      }
    }
    await Promise.all(creating);
  });
});
