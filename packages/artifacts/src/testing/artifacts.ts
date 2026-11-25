import { describe, expect, test, vi } from "vitest";

import type {
  ArtifactOperations,
  ArtifactResolved,
  Content,
  ContentId,
  StoredFile,
} from "../index";
import {
  ArtifactNotFoundError,
  Artifacts,
  ContentStateError,
  DuplicateTagError,
  FilePointerError,
  InvalidArtifactInputError,
  StaleContentError,
} from "../index";
import type { ArtifactStore } from "../store";
import { interceptCommits } from "./index";
import { isTransactional } from "./transactional";

const text = (value: string, mime = "text/html") => ({ bytes: value, mime });
function contentOf(artifact: ArtifactResolved): Content {
  if (!artifact.content) {
    throw new Error("Expected Content");
  }
  return artifact.content;
}
function file(content: Content): StoredFile {
  const entry = content.tree["file.txt"];
  if (entry?.type !== "file") {
    throw new Error("Expected stored file");
  }
  return entry;
}

type StoreRead = Exclude<keyof ArtifactStore, "commit" | "transaction">;

function pausable(store: ArtifactStore) {
  let armed:
    | {
        readonly read: StoreRead;
        readonly reached: () => void;
        readonly held: Promise<void>;
      }
    | undefined;
  async function gate<T>(read: StoreRead, value: Promise<T>): Promise<T> {
    const result = await value;
    const pause = armed;
    if (pause?.read === read) {
      armed = undefined;
      pause.reached();
      await pause.held;
    }
    return result;
  }
  function wrap(target: ArtifactStore): ArtifactStore {
    return {
      commit: (write) => target.commit(write),
      ...(target.durability === undefined
        ? {}
        : { durability: target.durability }),
      findBlobs: (digest) => gate("findBlobs", target.findBlobs(digest)),
      findReferences: (id) => gate("findReferences", target.findReferences(id)),
      getArtifact: (id) => gate("getArtifact", target.getArtifact(id)),
      getBlob: (id) => gate("getBlob", target.getBlob(id)),
      getContent: (id) => gate("getContent", target.getContent(id)),
      listArtifacts: (query) =>
        gate("listArtifacts", target.listArtifacts(query)),
      listBlobs: () => gate("listBlobs", target.listBlobs()),
      listContents: (artifactId) =>
        gate("listContents", target.listContents(artifactId)),
      ...(isTransactional(target)
        ? {
            transaction: (work) =>
              target.transaction((view) => work(wrap(view))),
          }
        : {}),
    };
  }
  return {
    pause(read: StoreRead) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      armed = { held, reached, read };
      return { reached: arrived, release };
    },
    store: wrap(store),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Still pending after ${ms} ms`)),
      ms
    );
  });
  return Promise.race([promise, hung]).finally(() => clearTimeout(timer));
}

export function describeArtifacts(
  name: string,
  createStore: () => ArtifactStore | Promise<ArtifactStore>
): void {
  async function harness() {
    const store = await createStore();
    const mutations: string[] = [];
    const artifacts = new Artifacts({ store });
    artifacts.observe((id) => mutations.push(id));
    return { artifacts, mutations, store };
  }
  describe(`${name} Artifacts`, () => {
    test("stores structural entries without blobs and removes directories recursively", async () => {
      const { artifacts, store } = await harness();
      const before = (await store.listBlobs()).length;
      const artifact = await artifacts.create({
        entries: {
          device: { type: "device" },
          empty: { type: "directory" },
          link: { target: "../missing", type: "symlink" },
          pipe: { type: "pipe" },
          socket: { type: "socket" },
          "src/file.txt": text("structural fixture", "text/plain"),
        },
        name: "Structure",
        type: "application/octet-stream",
      });
      const content = contentOf(artifact);
      expect(content.tree).toMatchObject({
        device: { type: "device" },
        empty: { type: "directory" },
        link: { target: "../missing", type: "symlink" },
        pipe: { type: "pipe" },
        socket: { type: "socket" },
        src: { type: "directory" },
        "src/file.txt": { bytes: 18, type: "file" },
      });
      expect((await store.listBlobs()).length).toBe(before + 1);
      for (const path of ["empty", "src", "link", "socket", "pipe", "device"]) {
        expect(await artifacts.readFile(content.id, path)).toBeNull();
      }
      await expect(
        artifacts.write({
          artifactId: artifact.id,
          changes: { put: { src: text("invalid parent") } },
        })
      ).rejects.toThrow();
      const restored = await artifacts.get(artifact.id);
      if (!restored) {
        throw new Error("Missing artifact");
      }
      expect(contentOf(restored).tree).toEqual(content.tree);
      const written = await artifacts.write({
        artifactId: artifact.id,
        changes: { remove: ["src"] },
      });
      expect(written.tree).not.toHaveProperty("src");
      expect(written.tree).not.toHaveProperty("src/file.txt");
      expect(written.tree.empty).toEqual({ type: "directory" });
      expect((await store.listBlobs()).length).toBe(before);
    });
    test("explicit revision preserves predecessors without publication and rolls back invalid contributions", async () => {
      const { artifacts, store, mutations } = await harness();
      const artifact = await artifacts.create({
        entries: { "index.html": text("before") },
        metadata: {
          custom: { value: 1 },
          entry: "index.html",
          sessionId: "session",
        },
        name: "Revision",
        type: "text/html",
      });
      const source = contentOf(artifact);
      const count = (await store.listBlobs()).length;
      const notifications = mutations.length;
      await expect(
        artifacts.revise({
          artifactId: artifact.id,
          changes: { put: { "new.html": text("new bytes") }, replace: true },
          contentId: source.id,
          expectedUpdatedAt: source.updatedAt,
        })
      ).rejects.toBeInstanceOf(FilePointerError);
      expect(await artifacts.get(artifact.id)).toEqual(artifact);
      expect((await store.listBlobs()).length).toBe(count);
      expect(mutations).toHaveLength(notifications);
      const successor = await artifacts.revise({
        artifactId: artifact.id,
        contentId: source.id,
        expectedUpdatedAt: source.updatedAt,
      });
      expect(successor.id).not.toBe(source.id);
      expect(successor.state).toBe("ready");
      expect(successor.artifact.status).toBe("draft");
      expect(successor.artifact.publishedAt).toBeNull();
      expect(successor.metadata).toEqual({
        custom: { value: 1 },
        entry: "index.html",
        from: source.id,
      });
      const preserved = await artifacts.getContent(source.id);
      expect(preserved).toMatchObject({
        digest: source.digest,
        metadata: source.metadata,
        state: "frozen",
        tree: source.tree,
      });
      await expect(
        artifacts.revise({
          artifactId: artifact.id,
          contentId: source.id,
          expectedUpdatedAt: source.updatedAt,
        })
      ).rejects.toBeInstanceOf(StaleContentError);
      await artifacts.freeze(successor.id);
      await expect(
        artifacts.write({ artifactId: artifact.id, changes: {} })
      ).rejects.toBeInstanceOf(ContentStateError);
      const frozen = await artifacts.getContent(successor.id);
      if (!frozen) {
        throw new Error("missing frozen source");
      }
      await artifacts.revise({
        artifactId: artifact.id,
        contentId: frozen.id,
        expectedUpdatedAt: frozen.updatedAt,
      });
      expect(await artifacts.getContent(frozen.id)).toMatchObject({
        frozenAt: frozen.frozenAt,
        metadata: frozen.metadata,
        tree: frozen.tree,
        updatedAt: frozen.updatedAt,
      });
    });
    test("same-millisecond edits, metadata and freeze advance the Content fence", async () => {
      const { artifacts } = await harness();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
        const created = await artifacts.create({
          entries: { "index.html": text("first") },
          name: "Fence",
          type: "text/html",
        });
        const first = contentOf(created);
        const edited = await artifacts.write({
          artifactId: created.id,
          changes: { put: { "index.html": text("second") } },
        });
        expect(edited.updatedAt.getTime()).toBe(first.updatedAt.getTime() + 1);
        const metadata = await artifacts.setMetadata(first.id, {
          note: "changed",
        });
        expect(metadata.updatedAt.getTime()).toBe(
          edited.updatedAt.getTime() + 1
        );
        const frozen = await artifacts.freeze(first.id);
        expect(frozen.updatedAt.getTime()).toBe(
          metadata.updatedAt.getTime() + 1
        );
        const labeled = await artifacts.setMetadata(first.id, {
          label: "Checkpoint",
        });
        expect(labeled.updatedAt.getTime()).toBe(
          frozen.updatedAt.getTime() + 1
        );
        expect(labeled.state).toBe("frozen");
        expect(labeled.tree).toEqual(frozen.tree);
        await expect(
          artifacts.write({
            artifactId: created.id,
            changes: {},
            expectedUpdatedAt: first.updatedAt,
          })
        ).rejects.toBeInstanceOf(StaleContentError);
      } finally {
        vi.useRealTimers();
      }
    });
    test("create with files, autosave in place, publish, edit after freeze", async () => {
      const { store, artifacts, mutations } = await harness();
      const before = (await store.listBlobs()).length;

      const created = await artifacts.create({
        entries: {
          "index.html": text("<h1>v1</h1>"),
          "style.css": text("h1{}", "text/css"),
        },
        name: "Landing",
        type: "text/html",
      });
      const first = contentOf(created);
      expect(created.status).toBe("draft");
      expect(first.state).toBe("ready");
      expect(Object.keys(first.tree).sort()).toEqual([
        "index.html",
        "style.css",
      ]);
      expect((await store.listBlobs()).length).toBe(before + 2);
      const firstId = first.id;

      const saved = await artifacts.write({
        artifactId: created.id,
        changes: { put: { "index.html": text("<h1>v2</h1>") } },
        expectedContentId: firstId,
      });
      expect(saved.id).toBe(firstId);
      expect(saved.digest).not.toBe(first.digest);
      expect((await store.listBlobs()).length).toBe(before + 2);
      await new Promise((resolve) => setTimeout(resolve, 2));

      const published = await artifacts.write({
        artifactId: created.id,
        changes: {},
        freeze: {},
      });
      expect(published.id).toBe(firstId);
      expect(published.state).toBe("frozen");
      expect(published.artifact.status).toBe("published");
      expect(published.artifact.publishedAt).not.toBeNull();

      const edited = await artifacts.revise({
        artifactId: created.id,
        changes: { put: { "style.css": text("h1{color:red}", "text/css") } },
        contentId: published.id,
        expectedUpdatedAt: published.updatedAt,
      });
      expect(edited.id).not.toBe(firstId);
      expect(edited.state).toBe("ready");
      expect(edited.metadata.from).toBe(firstId);
      expect(edited.artifact.contentId).toBe(edited.id);
      expect(edited.tree["index.html"]).toEqual(published.tree["index.html"]);
      expect((await store.listBlobs()).length).toBe(before + 3);

      const timeline = await artifacts.listContents(created.id);
      expect(timeline.map((c) => c.state)).toEqual(["frozen", "ready"]);
      expect(
        mutations.filter((id) => id === created.id).length
      ).toBeGreaterThan(0);
    });
    test("fences, select, fork, tags", async () => {
      const { artifacts } = await harness();
      const a = await artifacts.create({
        entries: { "doc.md": text("# one", "text/markdown") },
        freeze: { tag: "v1" },
        name: "Doc",
        type: "text/markdown",
      });
      const v1 = contentOf(a).id;
      expect(a.status).toBe("published");
      expect(contentOf(a).tag).toBe("v1");

      await expect(
        artifacts.write({
          artifactId: a.id,
          changes: {},
          expectedContentId: "other" as ContentId,
        })
      ).rejects.toBeInstanceOf(StaleContentError);

      const v2 = await artifacts.revise({
        artifactId: a.id,
        changes: { put: { "doc.md": text("# two", "text/markdown") } },
        contentId: v1,
        expectedUpdatedAt: contentOf(a).updatedAt,
      });
      await artifacts.freeze(v2.id);
      await expect(artifacts.tag(v2.id, "v1")).rejects.toBeInstanceOf(
        DuplicateTagError
      );
      await artifacts.tag(v2.id, "v2");

      const selected = await artifacts.select({
        artifactId: a.id,
        contentId: v1,
      });
      expect(selected.contentId).toBe(v1);
      expect((await artifacts.listContents(a.id)).length).toBe(2);

      const v3 = await artifacts.revise({
        artifactId: a.id,
        changes: { put: { "notes.md": text("x", "text/markdown") } },
        contentId: v1,
        expectedUpdatedAt: contentOf(a).updatedAt,
      });
      expect(v3.metadata.from).toBe(v1);
      expect(Object.keys(v3.tree).sort()).toEqual(["doc.md", "notes.md"]);

      const forked = await artifacts.fork({
        contentId: v3.id,
        name: "Doc copy",
      });
      expect(forked.id).not.toBe(a.id);
      expect(forked.name).toBe("Doc copy");
      expect(forked.content?.metadata.from).toBe(v3.id);
      expect(forked.content?.digest).toBe(v3.digest);
      expect((await artifacts.getContent(v3.id))?.state).toBe("frozen");

      const forkedContent = contentOf(forked);
      await expect(
        artifacts.select({ artifactId: a.id, contentId: forkedContent.id })
      ).rejects.toBeInstanceOf(InvalidArtifactInputError);
    });
    test("resolves files and roots, validates pointers, reads by session", async () => {
      const { artifacts } = await harness();
      const a = await artifacts.create({
        entries: {
          "outputs/index.html": text("<p>root</p>"),
          "outputs/main.js": text("1", "text/javascript"),
          profile: text("{}", "application/json"),
        },
        metadata: {
          entries: { main: "outputs/main.js" },
          entry: "outputs/index.html",
          messageId: "M",
          sessionId: "S",
        },
        name: "Site",
        type: "text/html",
      });
      const { id } = contentOf(a);
      expect(
        new TextDecoder().decode((await artifacts.readRoot(id))?.blob)
      ).toBe("<p>root</p>");
      expect((await artifacts.readNamedRoot(id, "main"))?.mime).toBe(
        "text/javascript"
      );
      expect(await artifacts.readThumbnail(id)).toBeNull();
      expect(await artifacts.readFile(id, "nope")).toBeNull();
      expect(
        (await artifacts.findContent(a.id, { messageId: "M", sessionId: "S" }))
          ?.id
      ).toBe(id);
      expect(
        await artifacts.findContent(a.id, { messageId: "X", sessionId: "S" })
      ).toBeNull();

      await expect(
        artifacts.write({
          artifactId: a.id,
          changes: { remove: ["outputs/index.html"] },
        })
      ).rejects.toBeInstanceOf(FilePointerError);
      await expect(
        artifacts.setMetadata(id, { thumbnail: "missing.png" })
      ).rejects.toBeInstanceOf(FilePointerError);

      const single = await artifacts.create({
        entries: {
          "hero.png": { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" },
        },
        name: "One",
        type: "image/png",
      });
      expect((await artifacts.readRoot(contentOf(single).id))?.path).toBe(
        "hero.png"
      );
      const indexed = await artifacts.create({
        entries: { "b.css": text("b", "text/css"), "index.html": text("a") },
        name: "Two",
        type: "text/html",
      });
      expect((await artifacts.readRoot(contentOf(indexed).id))?.path).toBe(
        "index.html"
      );
    });
    test("archive, list, rename, delete", async () => {
      const { artifacts } = await harness();
      const type = `test/${crypto.randomUUID()}`;
      const a = await artifacts.create({
        entries: { f: text("a") },
        name: "A",
        type,
      });
      const b = await artifacts.create({ name: "B", type });
      expect(b.content).toBeNull();

      await artifacts.archive(a.id);
      expect((await artifacts.list({ type })).items.map((x) => x.id)).toEqual([
        b.id,
      ]);
      expect(
        (await artifacts.list({ includeArchived: true, type })).items.length
      ).toBe(2);
      const restored = await artifacts.unarchive(a.id);
      expect(restored.status).toBe("draft");

      const page = await artifacts.list({ limit: 1, type });
      expect(page.total).toBe(2);
      expect(page.items.length).toBe(1);
      expect(page.nextCursor).toBeDefined();
      const rest = await artifacts.list({
        cursor: page.nextCursor,
        limit: 1,
        type,
      });
      expect(rest.items[0]?.id).not.toBe(page.items[0]?.id);
      expect(rest.total).toBe(2);
      expect(rest.nextCursor).toBeUndefined();
      expect(await artifacts.list({ query: "missing", type })).toEqual({
        items: [],
        total: 0,
      });

      expect((await artifacts.rename(a.id, "Renamed")).name).toBe("Renamed");
      await expect(artifacts.rename(a.id, "  ")).rejects.toBeInstanceOf(
        InvalidArtifactInputError
      );

      expect(await artifacts.delete(a.id)).toBe(true);
      expect(await artifacts.delete(a.id)).toBe(false);
      expect(await artifacts.get(a.id)).toBeNull();
      await expect(artifacts.rename(a.id, "x")).rejects.toBeInstanceOf(
        ArtifactNotFoundError
      );
    });

    test("preserves shared blobs through fork edits and only reclaims the final reference", async () => {
      const { artifacts, store } = await harness();
      const original = await artifacts.create({
        entries: { "file.txt": { bytes: crypto.randomUUID() } },
        name: "Original",
        type: "text/plain",
      });
      const originalBlob = file(contentOf(original)).blobId;
      const fork = await artifacts.fork({
        contentId: contentOf(original).id,
      });
      expect(file(contentOf(fork)).blobId).toBe(originalBlob);
      const edited = await artifacts.write({
        artifactId: fork.id,
        changes: { put: { "file.txt": { bytes: crypto.randomUUID() } } },
      });
      const replacement = file(edited).blobId;
      expect(replacement).not.toBe(originalBlob);
      await artifacts.delete(original.id);
      expect(await store.getBlob(originalBlob)).toBeNull();
      expect(await store.getBlob(replacement)).not.toBeNull();
      await artifacts.delete(fork.id);
      expect(await store.getBlob(replacement)).toBeNull();
    });

    test("reuses an exclusive ready blob and enforces concurrent write fences", async () => {
      const { artifacts } = await harness();
      const original = await artifacts.create({
        entries: { "file.txt": { bytes: crypto.randomUUID() } },
        name: "Exclusive",
        type: "text/plain",
      });
      const before = contentOf(original);
      const write = (bytes: string) =>
        artifacts.write({
          artifactId: original.id,
          changes: { put: { "file.txt": { bytes } } },
          expectedContentId: original.contentId,
          expectedUpdatedAt: before.updatedAt,
        });
      const [first, second] = await Promise.allSettled([
        write(crypto.randomUUID()),
        write(crypto.randomUUID()),
      ]);
      if (first.status !== "fulfilled" || second.status !== "rejected") {
        throw new Error("Expected one winner");
      }
      expect(first.value.id).toBe(before.id);
      expect(file(first.value).blobId).toBe(file(before).blobId);
      expect(second.reason).toBeInstanceOf(StaleContentError);
    });

    test("enforces write fences between two managers over one store", async () => {
      const store = await createStore();
      const one = new Artifacts({ store });
      const other = new Artifacts({ store });
      const original = await one.create({
        entries: { "file.txt": { bytes: "start" } },
        name: "Shared",
        type: "text/plain",
      });
      const write = (artifacts: Artifacts, bytes: string) =>
        artifacts.write({
          artifactId: original.id,
          changes: { put: { "file.txt": { bytes } } },
          expectedUpdatedAt: contentOf(original).updatedAt,
        });
      const results = await Promise.allSettled([
        write(one, "one"),
        write(other, "other"),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
    });

    test("rolls back records and notifications and expires scoped handles", async () => {
      const { artifacts, mutations } = await harness();
      let scoped: ArtifactOperations | undefined;
      let id: ArtifactResolved["id"] | undefined;
      await expect(
        artifacts.transaction(async (transaction) => {
          scoped = transaction;
          ({ id } = await transaction.create({
            entries: { "file.txt": { bytes: "abort" } },
            name: "Abort",
            type: "text/plain",
          }));
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");
      if (!(id && scoped)) {
        throw new Error("Expected transaction to execute");
      }
      expect(await artifacts.get(id)).toBeNull();
      expect(mutations).toEqual([]);
      await expect(scoped.list()).rejects.toThrow("settled");
    });

    test("runs every after-commit callback even when one fails", async () => {
      const { artifacts } = await harness();
      const applied: string[] = [];
      await expect(
        artifacts.transaction(async (transaction, effects) => {
          await transaction.create({ name: "Effects", type: "text/plain" });
          effects.afterCommit(() => {
            applied.push("first");
            return Promise.reject(new Error("application failed"));
          });
          effects.afterCommit(() => {
            applied.push("second");
            return Promise.resolve();
          });
        })
      ).rejects.toThrow("application failed");
      expect(applied).toEqual(["first", "second"]);
      expect((await artifacts.list()).total).toBe(1);
    });

    test("runs after-commit work once the change is released, so it can write again", async () => {
      const { artifacts } = await harness();
      const order: string[] = [];
      await artifacts.transaction(async (transaction, effects) => {
        await transaction.create({ name: "Outer", type: "text/plain" });
        effects.afterCommit(async () => {
          await artifacts.create({ name: "Nested", type: "text/plain" });
          order.push("nested write");
        });
        order.push("outer write");
      });
      expect(order).toEqual(["outer write", "nested write"]);
      expect((await artifacts.list()).total).toBe(2);
    }, 2000);

    test("runs a call made by work a transaction scheduled, while that transaction commits, once it settles", async () => {
      const reached = Promise.withResolvers<undefined>();
      const held = Promise.withResolvers<undefined>();
      let holding = true;
      const store = interceptCommits(
        await createStore(),
        async (write, commit) => {
          if (holding) {
            holding = false;
            reached.resolve(undefined);
            await held.promise;
          }
          await commit(write);
        }
      );
      const artifacts = new Artifacts({ store });
      const trigger = Promise.withResolvers<undefined>();
      let later: Promise<ArtifactResolved> | undefined;
      const outer = artifacts.transaction(async (transaction) => {
        await transaction.create({ name: "Outer", type: "text/plain" });
        trigger.promise.then(() => {
          later = artifacts.create({ name: "Later", type: "text/plain" });
        });
      });
      await reached.promise;
      trigger.resolve(undefined);
      await settle();
      held.resolve(undefined);
      await outer;

      expect((await within(later ?? Promise.reject(), 1000)).name).toBe(
        "Later"
      );
      expect((await artifacts.list()).total).toBe(2);
    });

    test("discards after-commit work when the change rolls back", async () => {
      const { artifacts } = await harness();
      let ran = false;
      await expect(
        artifacts.transaction((_transaction, effects) => {
          effects.afterCommit(() => {
            ran = true;
            return Promise.resolve();
          });
          return Promise.reject(new Error("rolled back"));
        })
      ).rejects.toThrow("rolled back");
      expect(ran).toBe(false);
    });

    async function sharedStore() {
      const shared = pausable(await createStore());
      const reader = new Artifacts({ store: shared.store });
      const writer = new Artifacts({ store: shared.store });
      const created = await writer.create({
        entries: { "file.txt": text("kept", "text/plain") },
        name: "Shared",
        type: "text/plain",
      });
      return { created, reader, shared, writer };
    }

    test("gets one state while another Artifacts instance deletes the Artifact", async () => {
      const { created, reader, shared, writer } = await sharedStore();
      const paused = shared.pause("getArtifact");
      const read = reader.get(created.id);
      await paused.reached;
      const deleted = writer.delete(created.id);
      await settle();
      paused.release();
      expect((await read)?.content?.id).toBe(created.contentId);
      expect(await deleted).toBe(true);
      expect(await reader.get(created.id)).toBeNull();
    });

    test("lists one state while another Artifacts instance deletes a listed Artifact", async () => {
      const { created, reader, shared, writer } = await sharedStore();
      const paused = shared.pause("listArtifacts");
      const read = reader.list();
      await paused.reached;
      const deleted = writer.delete(created.id);
      await settle();
      paused.release();
      const page = await read;
      expect(page.items.map((item) => item.content?.id)).toEqual([
        created.contentId,
      ]);
      expect(await deleted).toBe(true);
      expect((await reader.list()).items).toEqual([]);
    });

    test("refuses at once a call on another Artifacts instance from inside a transaction, even with that instance's own call waiting", async ({
      skip,
    }) => {
      const store = await createStore();
      if (!isTransactional(store)) {
        return skip();
      }
      const first = new Artifacts({ store });
      const second = new Artifacts({ store });
      const entered = Promise.withResolvers<undefined>();
      const proceed = Promise.withResolvers<undefined>();
      const outer = first.transaction(async () => {
        entered.resolve(undefined);
        await proceed.promise;
        return await second.list();
      });
      await entered.promise;
      const waiting = second.create({ name: "Waiting", type: "text/plain" });
      await settle();
      proceed.resolve(undefined);

      await expect(within(outer, 1000)).rejects.toThrow(
        "inside its own transaction"
      );
      expect((await within(waiting, 1000)).name).toBe("Waiting");
      expect((await first.list()).total).toBe(1);
    });

    async function* streamOf(label: string): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      yield new TextEncoder().encode(label);
    }

    for (const [kind, call] of [
      [
        "a write with bytes",
        (artifacts: Artifacts, created: ArtifactResolved, label: string) =>
          artifacts.write({
            artifactId: created.id,
            changes: { put: { "file.txt": { bytes: label } } },
          }),
      ],
      [
        "a stream write",
        (artifacts: Artifacts, created: ArtifactResolved, label: string) =>
          artifacts.write({
            artifactId: created.id,
            changes: { put: { "file.txt": { source: streamOf(label) } } },
          }),
      ],
      [
        "a Content-named change",
        (artifacts: Artifacts, created: ArtifactResolved, label: string) =>
          artifacts.setMetadata(contentOf(created).id, { label }),
      ],
    ] as const) {
      test(`refuses at once ${kind} to an Artifact another Artifacts instance's own call to it waits on, from inside a transaction`, async ({
        skip,
      }) => {
        const store = await createStore();
        if (!isTransactional(store)) {
          return skip();
        }
        const first = new Artifacts({ store });
        const second = new Artifacts({ store });
        const created = await second.create({
          entries: { "file.txt": { bytes: "start" } },
          name: "Shared",
          type: "text/plain",
        });
        const entered = Promise.withResolvers<undefined>();
        const proceed = Promise.withResolvers<undefined>();
        const outer = first.transaction(async () => {
          entered.resolve(undefined);
          await proceed.promise;
          return await call(second, created, "inner");
        });
        await entered.promise;
        const waiting = call(second, created, "outer");
        await settle();
        proceed.resolve(undefined);

        await expect(within(outer, 1000)).rejects.toThrow(
          "inside its own transaction"
        );
        await within(waiting, 1000);
      });
    }

    async function patchConcurrently(
      shared: ReturnType<typeof pausable>,
      created: ArtifactResolved,
      patchers: readonly [Artifacts, Artifacts]
    ) {
      const contentId = contentOf(created).id;
      const paused = shared.pause("getContent");
      const firstPatch = patchers[0].setMetadata(contentId, { first: 1 });
      await paused.reached;
      const secondPatch = patchers[1].setMetadata(contentId, { second: 2 });
      await settle();
      paused.release();
      await Promise.all([firstPatch, secondPatch]);
      return (await patchers[0].getContent(contentId))?.metadata;
    }

    test("keeps concurrent read-modify-writes on one Artifacts instance from interleaving", async () => {
      const { created, shared, writer } = await sharedStore();

      expect(
        await patchConcurrently(shared, created, [writer, writer])
      ).toMatchObject({ first: 1, second: 2 });
    });

    test("keeps concurrent read-modify-writes on two managers over one store from interleaving", async ({
      skip,
    }) => {
      const { created, reader, shared, writer } = await sharedStore();
      if (!isTransactional(shared.store)) {
        return skip();
      }

      expect(
        await patchConcurrently(shared, created, [reader, writer])
      ).toMatchObject({ first: 1, second: 2 });
    });

    test("reads a file from one state while another Artifacts instance rewrites it", async () => {
      const { created, reader, shared, writer } = await sharedStore();
      const contentId = contentOf(created).id;
      const paused = shared.pause("getContent");
      const read = reader.readFile(contentId, "file.txt");
      await paused.reached;
      const written = writer.write({
        artifactId: created.id,
        changes: { put: { "file.txt": text("replaced", "text/plain") } },
      });
      await settle();
      paused.release();
      expect(new TextDecoder().decode((await read)?.blob)).toBe("kept");
      await written;
      const after = await reader.readFile(contentId, "file.txt");
      expect(new TextDecoder().decode(after?.blob)).toBe("replaced");
    });
  });
}
