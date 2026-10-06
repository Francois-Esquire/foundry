import { describe, expect, test, vi } from "vitest";

import type {
  ArtifactResolved,
  ArtifactStore,
  Content,
  ContentId,
} from "../index";
import {
  ArtifactManager,
  ArtifactNotFoundError,
  ContentStateError,
  DuplicateTagError,
  FilePointerError,
  InvalidArtifactInputError,
  StaleContentError,
} from "../index";
import { readStore } from "./store";

const text = (value: string, mime = "text/html") => ({ bytes: value, mime });
function contentOf(artifact: ArtifactResolved): Content {
  if (!artifact.content) {
    throw new Error("Expected Content");
  }
  return artifact.content;
}
export function describeArtifactManager(
  name: string,
  createStore: () => ArtifactStore
): void {
  function harness() {
    const store = createStore();
    const mutations: string[] = [];
    const artifacts = new ArtifactManager({ store });
    artifacts.observe((id) => mutations.push(id));
    return { artifacts, mutations, store };
  }
  describe(`${name} Artifact manager`, () => {
    test("stores structural entries without blobs and removes directories recursively", async () => {
      const { artifacts, store } = harness();
      const before = (await readStore(store, (scoped) => scoped.listBlobs()))
        .length;
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
      expect(
        (await readStore(store, (scoped) => scoped.listBlobs())).length
      ).toBe(before + 1);
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
      expect(
        (await readStore(store, (scoped) => scoped.listBlobs())).length
      ).toBe(before);
    });
    test("explicit revision preserves predecessors without publication and rolls back invalid contributions", async () => {
      const { artifacts, store, mutations } = harness();
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
      const count = (await readStore(store, (scoped) => scoped.listBlobs()))
        .length;
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
      expect(
        (await readStore(store, (scoped) => scoped.listBlobs())).length
      ).toBe(count);
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
      const { artifacts } = harness();
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
      const { store, artifacts, mutations } = harness();
      const before = (await readStore(store, (scoped) => scoped.listBlobs()))
        .length;

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
      expect(
        (await readStore(store, (scoped) => scoped.listBlobs())).length
      ).toBe(before + 2);
      const firstId = first.id;

      // autosave rewrites the ready row and reclaims the replaced blob
      const saved = await artifacts.write({
        artifactId: created.id,
        changes: { put: { "index.html": text("<h1>v2</h1>") } },
        expectedContentId: firstId,
      });
      expect(saved.id).toBe(firstId);
      expect(saved.digest).not.toBe(first.digest);
      expect(
        (await readStore(store, (scoped) => scoped.listBlobs())).length
      ).toBe(before + 2);
      await new Promise((resolve) => setTimeout(resolve, 2));

      // publish = freeze in place; artifact becomes published
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
      // the frozen row still names the old css blob, so nothing was reclaimed
      expect(
        (await readStore(store, (scoped) => scoped.listBlobs())).length
      ).toBe(before + 3);

      const timeline = await artifacts.listContents(created.id);
      expect(timeline.map((c) => c.state)).toEqual(["frozen", "ready"]);
      expect(
        mutations.filter((id) => id === created.id).length
      ).toBeGreaterThan(0);
    });
    test("fences, select, fork, tags", async () => {
      const { artifacts } = harness();
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

      // select an old checkpoint: pointer moves, nothing copied
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

      // fork freezes a ready source and starts a new artifact from its tree
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
      const { artifacts } = harness();
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

      // single-file and index.html root rules
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
      const { artifacts } = harness();
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
  });
}
