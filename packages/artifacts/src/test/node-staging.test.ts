import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Artifacts } from "../artifacts";
import type { BlobFiles } from "../blob-staging";
import { CHUNK_BYTES, MAX_STAGING_STREAMS } from "../blob-staging";
import { FileTooLargeError, StaleContentError } from "../errors";
import { blobFiles } from "../node";
import { STAGING_ABANDONED_AFTER_MS } from "../node/staging";
import type { Content, FileInput } from "../substrate";
import { interceptCommits } from "../testing";
import { required } from "./helpers/required";
import {
  chunk,
  decoded,
  gated,
  publishedFiles,
  referencedFiles,
  stagedFiles,
  storage,
  text,
  within,
} from "./helpers/staging";
import { STORE_KINDS } from "./helpers/stores";

const HOUR = 60 * 60 * 1000;
async function age(path: string, ms: number): Promise<void> {
  const then = new Date(Date.now() - ms);
  await utimes(path, then, then);
}
async function ownerDirectory(blobs: string, ms: number): Promise<string> {
  const owner = crypto.randomUUID();
  const directory = join(blobs, ".staging", owner);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, crypto.randomUUID()), "staged elsewhere");
  await age(directory, ms);
  return owner;
}
function file(content: Content | null | undefined, path: string) {
  const entry = required(content).tree[path];
  if (entry?.type !== "file") {
    throw new Error(`Expected file ${path}`);
  }
  return entry;
}
function withoutStaging(files: BlobFiles): BlobFiles {
  return {
    list: () => files.list(),
    publish: (bytes) => files.publish(bytes),
    read: (path, range) => files.read(path, range),
    remove: (path) => files.remove(path),
  };
}

describe.each(STORE_KINDS)("%s store: staged blob bytes", (kind) => {
  it("keep a stalled source from holding the store for other managers", async () => {
    const { blobs, lockHeld, openArtifacts, settled } = await storage(kind);
    const stalled = openArtifacts();
    const other = openArtifacts();
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
    const { blobs, openArtifacts, settled } = await storage(kind);
    const writer = openArtifacts();
    const other = openArtifacts();
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
    const { openArtifacts, settled } = await storage(kind);
    const writer = openArtifacts();
    const other = openArtifacts();
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
    let copy: Awaited<ReturnType<Artifacts["create"]>> | undefined;
    try {
      expect(await within(gate.waiting)).toBe("resolved");
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
    const { openArtifacts, settled, store } = await storage(kind);
    const first = openArtifacts();
    const second = openArtifacts();
    const gates = [gated([], [text("same")]), gated([], [text("same")])];
    const creating = [first, second].map((artifacts, index) =>
      artifacts.create({
        entries: { "same.txt": { source: required(gates[index]).source } },
        name: `Same ${String(index)}`,
        type: "text/plain",
      })
    );
    try {
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
      const { blobs, openArtifacts, settled } = await storage(kind);
      const { seen, source } = failing(blobs, () => {
        throw new Error("source failed");
      });
      await expect(
        openArtifacts().create({
          entries: { "f.bin": { source } },
          name: "Broken",
          type: "application/octet-stream",
        })
      ).rejects.toThrow("source failed");
      expect(seen.staged).toBe(1);
      await settled();
    });

    it("on an aborted source", async () => {
      const { blobs, openArtifacts, settled } = await storage(kind);
      const { seen, source } = failing(blobs, () => {
        throw new DOMException("The source was aborted", "AbortError");
      });
      await expect(
        openArtifacts().create({
          entries: { "f.bin": { source } },
          name: "Aborted",
          type: "application/octet-stream",
        })
      ).rejects.toThrow("aborted");
      expect(seen.staged).toBe(1);
      await settled();
    });

    it("on a source past the file limit", async () => {
      const { blobs, openArtifacts, settled } = await storage(kind);
      const { seen, source } = failing(blobs, () => text("over"));
      await expect(
        openArtifacts({ maxFileBytes: CHUNK_BYTES + 1 }).create({
          entries: { "f.bin": { source } },
          name: "Large",
          type: "application/octet-stream",
        })
      ).rejects.toBeInstanceOf(FileTooLargeError);
      expect(seen.staged).toBe(1);
      await settled();
    });

    it("on a commit that does not land", async () => {
      const { blobs, openArtifacts, open, settled } = await storage(kind);
      const refusing = interceptCommits(open(), () =>
        Promise.reject(new Error("commit refused"))
      );
      const { seen, source } = failing(blobs, () => text("end"));
      await expect(
        openArtifacts({ store: refusing }).create({
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
    const { blobs, openArtifacts, store } = await storage(kind);
    const artifacts = openArtifacts();
    await artifacts.create({
      entries: { "kept.txt": { bytes: "kept" } },
      name: "Kept",
      type: "text/plain",
    });
    const old = await ownerDirectory(blobs, STAGING_ABANDONED_AFTER_MS + HOUR);
    const fresh = await ownerDirectory(blobs, 0);
    await writeFile(join(blobs, crypto.randomUUID()), "promoted, never named");
    const live = openArtifacts();
    const gate = gated([chunk(4)], [text("live")]);
    const staging = live.create({
      entries: { "live.bin": { source: gate.source } },
      name: "Live",
      type: "application/octet-stream",
    });
    try {
      expect(await within(gate.waiting)).toBe("resolved");
      const own = required(
        (await stagedFiles(blobs))
          .map((path) => path.split("/")[0])
          .find((name) => name !== fresh)
      );
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
    const { openArtifacts } = await storage(kind);
    const artifacts = openArtifacts();
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
    const { blobs, openArtifacts } = await storage(kind);
    const files = blobFiles(blobs);
    const gate = gated([chunk(6)], []);
    const creating = openArtifacts({ files }).create({
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
        await Array.fromAsync(files.read(name, { end: 1, start: 0 }));
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
    const { blobs, openArtifacts, store } = await storage(kind);
    const chosen = {
      none: null,
      plain: withoutStaging(blobFiles(blobs)),
      staging: blobFiles(blobs),
    }[files];
    return { artifacts: openArtifacts({ files: chosen }), blobs, store };
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
    }, 30_000);

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
    const { blobs, openArtifacts, settled } = await storage(kind);
    const stalled = openArtifacts();
    const other = openArtifacts();
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
    const { openArtifacts, settled } = await storage(kind);
    const reviser = openArtifacts();
    const other = openArtifacts();
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
    const { blobs, openArtifacts, settled } = await storage(kind);
    const seen: { staged?: number } = {};
    async function* source(): AsyncIterable<Uint8Array> {
      yield chunk(10);
      seen.staged = (await stagedFiles(blobs)).length;
      yield text("over");
    }
    await expect(
      openArtifacts({ maxTreeBytes: CHUNK_BYTES }).create({
        entries: { "f.bin": { source: source() } },
        name: "Tree",
        type: "application/octet-stream",
      })
    ).rejects.toBeInstanceOf(FileTooLargeError);
    expect(seen.staged).toBe(1);
    await settled();
  });
});

describe.each(STORE_KINDS)("%s store: Staging another owner left", (kind) => {
  it("is removed past the age when an instance first stages, without recover", async () => {
    const { blobs, openArtifacts } = await storage(kind);
    const old = await ownerDirectory(blobs, STAGING_ABANDONED_AFTER_MS + HOUR);
    const fresh = await ownerDirectory(blobs, 0);
    await openArtifacts().create({
      entries: { "f.txt": { bytes: "fresh" } },
      name: "Fresh",
      type: "text/plain",
    });
    const owners = await readdir(join(blobs, ".staging"));
    expect(owners).not.toContain(old);
    expect(owners).toContain(fresh);
  });
});

describe.each(STORE_KINDS)("%s store: Staging bounds", (kind) => {
  it("refuses a change once its staged bytes alone exceed the tree limit, before later streams end", async () => {
    const { blobs, openArtifacts } = await storage(kind);
    const artifacts = openArtifacts({ maxTreeBytes: CHUNK_BYTES });
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

  it("reads at most MAX_STAGING_STREAMS streams of one artifacts at once", async () => {
    const { openArtifacts } = await storage(kind);
    const artifacts = openArtifacts();
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
