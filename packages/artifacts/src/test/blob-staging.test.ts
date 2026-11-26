import { describe, expect, it, vi } from "vitest";
import { Artifacts } from "../artifacts";
import { MAX_STAGING_STREAMS } from "../blob-staging";
import {
  ArtifactExistsError,
  ArtifactNotFoundError,
  ContentNotFoundError,
  ContentStateError,
  InvalidArtifactInputError,
  StaleContentError,
} from "../errors";
import type { ContentId } from "../ids";
import { artifactIdSchema, blobIdSchema, contentIdSchema } from "../ids";
import type { ArtifactStore } from "../store";
import { MemoryArtifactStore } from "../store/memory";
import type { ArtifactResolved, Content } from "../substrate";
import { required } from "./helpers/required";
import {
  chunk,
  decoded,
  gated,
  referencedFiles,
  storage,
  text,
  within,
} from "./helpers/staging";
import { STORE_KINDS } from "./helpers/stores";

describe.each(STORE_KINDS)(
  "%s store: Staged blob bytes without files, and refusals ahead of them",
  (kind) => {
    it("keep a stalled source from holding a store without files", async () => {
      const { openArtifacts, store } = await storage(kind);
      const stalled = openArtifacts({ files: null });
      const other = openArtifacts({ files: null });
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
      const { openArtifacts } = await storage(kind);
      const artifacts = openArtifacts({ maxFileBytes: 4 });
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

describe.each(STORE_KINDS)(
  "%s store: A reference to a missing blob",
  (kind) => {
    function watched(fail?: () => never) {
      const read = { pulled: false };
      async function* source(): AsyncIterable<Uint8Array> {
        read.pulled = true;
        if (fail) {
          fail();
        }
        yield await new Promise<Uint8Array>(() => undefined);
      }
      return { read, source: source() };
    }
    const missingBlob = () => ({
      blobId: blobIdSchema.parse(crypto.randomUUID()),
    });

    it("refuses a change before its stalled stream is read", async () => {
      const { openArtifacts } = await storage(kind);
      const { read, source } = watched();
      const creating = openArtifacts().create({
        entries: { "a.bin": { source }, "b.txt": missingBlob() },
        name: "Missing",
        type: "application/octet-stream",
      });
      expect(await within(creating)).toBe("rejected");
      await expect(creating).rejects.toBeInstanceOf(InvalidArtifactInputError);
      expect(read.pulled).toBe(false);
    });

    it("wins over a source error and a byte limit", async () => {
      const { openArtifacts } = await storage(kind);
      const artifacts = openArtifacts({ maxFileBytes: 4 });
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
    const { openArtifacts } = await storage(kind);
    const artifacts = openArtifacts();
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
    const { openArtifacts } = await storage(kind);
    const artifacts = openArtifacts();
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

describe.each(STORE_KINDS)(
  "%s store: Ownership checks inside one transaction",
  (kind) => {
    it("let several in-place writes to the same path commit together", async () => {
      const { openArtifacts } = await storage(kind);
      const artifacts = openArtifacts();
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
      const { openArtifacts } = await storage(kind);
      const artifacts = openArtifacts();
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
    const { openArtifacts } = await storage(kind);
    const artifacts = openArtifacts();
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
      const { openArtifacts } = await storage(kind);
      const artifacts = openArtifacts();
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

describe.each(["memory", "json"] as const)(
  "%s store: a fork takes its place in its destination's order",
  (kind) => {
    it("waits behind an earlier stalled create of its destination id", async () => {
      const { openArtifacts } = await storage(kind);
      const artifacts = openArtifacts();
      const source = await artifacts.create({
        entries: { "f.txt": { bytes: "source" } },
        name: "Source",
        type: "text/plain",
      });
      const id = artifactIdSchema.parse(crypto.randomUUID());
      const gate = gated([], [text("created")]);
      const creating = artifacts.create({
        entries: { "f.txt": { source: gate.source } },
        id,
        name: "Created",
        type: "text/plain",
      });
      let forking: Promise<unknown> | undefined;
      try {
        expect(await within(gate.waiting)).toBe("resolved");
        forking = artifacts.fork({
          contentId: required(source.contentId),
          id,
        });
        forking.catch(() => undefined);
        expect(await within(forking, 200)).toBe("pending");
      } finally {
        gate.release();
      }
      await expect(creating).resolves.toMatchObject({ id, name: "Created" });
      await expect(forking).rejects.toBeInstanceOf(ArtifactExistsError);
    });

    it("holds a later change to its destination while it waits on its source", async () => {
      const { openArtifacts } = await storage(kind);
      const artifacts = openArtifacts();
      const source = await artifacts.create({
        entries: { "f.txt": { bytes: "source" } },
        name: "Source",
        type: "text/plain",
      });
      const id = artifactIdSchema.parse(crypto.randomUUID());
      const gate = gated([], [text("streamed")]);
      const streaming = artifacts.write({
        artifactId: source.id,
        changes: { put: { "f.txt": { source: gate.source } } },
      });
      let forking: Promise<unknown> | undefined;
      let renaming: Promise<unknown> | undefined;
      try {
        expect(await within(gate.waiting)).toBe("resolved");
        forking = artifacts.fork({
          contentId: required(source.contentId),
          id,
        });
        renaming = artifacts.rename(id, "Renamed");
        renaming.catch(() => undefined);
        expect(await within(renaming, 200)).toBe("pending");
      } finally {
        gate.release();
      }
      await streaming;
      await forking;
      await expect(renaming).resolves.toMatchObject({ id, name: "Renamed" });
    });
  }
);

class FailingLookups extends MemoryArtifactStore {
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
    const artifacts = new Artifacts({ store });
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
      new MemoryArtifactStore()
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
    const store = new MemoryArtifactStore();
    const artifacts = new Artifacts({ store });
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
    const { openArtifacts } = await storage(kind);
    const artifacts = openArtifacts();
    const created = await artifacts.create({
      entries: { "f.txt": { bytes: "start" } },
      name,
      type: "text/plain",
    });
    return { artifacts, created };
  }
  const later = (artifacts: Artifacts, id: ArtifactResolved["id"]) =>
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
