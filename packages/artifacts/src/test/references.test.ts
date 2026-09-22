import { describe, expect, it, vi } from "vitest";
import { InMemoryArtifactStore } from "../memory";
import { artifactIdSchema, contentIdSchema } from "../ref";
import { resolveReference } from "../references";
import type { Content } from "../substrate";
import { ArtifactSystem } from "../system";
import { required } from "./helpers/required";

function system() {
  return new ArtifactSystem({ store: new InMemoryArtifactStore() });
}

describe("Artifact references", () => {
  it("uses current Content by default and preserves a selected historical version", async () => {
    const artifacts = system();
    const created = await artifacts.create({
      entries: { "index.html": { bytes: "old" } },
      freeze: { tag: "v1" },
      name: "Page",
      type: "text/html",
    });
    const old = required(created.content);
    const next = await artifacts.revise({
      artifactId: created.id,
      changes: { put: { "index.html": { bytes: "new" } } },
      contentId: old.id,
      expectedUpdatedAt: old.updatedAt,
    });
    expect(
      await resolveReference(artifacts, { artifactId: created.id })
    ).toMatchObject({
      content: { id: next.id, state: "ready" },
      path: "index.html",
      status: "available",
    });
    expect(
      await resolveReference(artifacts, {
        artifactId: created.id,
        contentId: old.id,
      })
    ).toMatchObject({
      content: { id: old.id, state: "frozen" },
      entry: {
        digest:
          old.tree["index.html"]?.type === "file"
            ? old.tree["index.html"].digest
            : undefined,
        path: "index.html",
      },
      status: "available",
    });
    expect((await artifacts.getContent(next.id))?.state).toBe("ready");
  });

  it("prefers explicit files over declared build output without reading bytes", async () => {
    const artifacts = system();
    const created = await artifacts.create({
      entries: {
        "index.html": { bytes: "root" },
        "outputs/page.html": { bytes: "built" },
        "source/main.ts": { bytes: "source" },
      },
      metadata: { entry: "outputs/page.html" },
      name: "Page",
      type: "text/html",
    });
    const readFile = vi.spyOn(artifacts, "readFile");
    expect(
      await resolveReference(artifacts, { artifactId: created.id })
    ).toMatchObject({ path: "outputs/page.html" });
    expect(
      await resolveReference(artifacts, {
        artifactId: created.id,
        path: "index.html",
      })
    ).toMatchObject({ path: "index.html" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    { expected: "image.png", paths: ["image.png"] },
    { expected: "index.html", paths: ["index.html", "style.css"] },
    { expected: null, paths: ["one.txt", "two.txt"] },
  ])("chooses the default for $paths", async ({ paths, expected }) => {
    const artifacts = system();
    const artifact = await artifacts.create({
      entries: Object.fromEntries(paths.map((path) => [path, { bytes: path }])),
      name: "Files",
      type: "files",
    });
    expect(
      await resolveReference(artifacts, { artifactId: artifact.id })
    ).toMatchObject({ path: expected, status: "available" });
  });

  it("retains empty artifacts and unmatched routes for specialized handlers", async () => {
    const artifacts = system();
    const artifact = await artifacts.create({ name: "Module", type: "module" });
    expect(
      await resolveReference(artifacts, { artifactId: artifact.id })
    ).toMatchObject({
      content: null,
      entry: null,
      path: null,
      status: "available",
    });
    expect(
      await resolveReference(artifacts, {
        artifactId: artifact.id,
        path: "dashboard",
      })
    ).toMatchObject({
      content: null,
      entry: null,
      path: "dashboard",
      status: "available",
    });
  });

  it("preserves structural entries and does not replace a missing explicit file", async () => {
    const artifacts = system();
    const artifact = await artifacts.create({
      entries: {
        empty: { type: "directory" },
        "index.html": { bytes: "page" },
        link: { target: "index.html", type: "symlink" },
      },
      name: "Tree",
      type: "files",
    });
    expect(
      await resolveReference(artifacts, {
        artifactId: artifact.id,
        path: "empty",
      })
    ).toMatchObject({ entry: { path: "empty", type: "directory" } });
    expect(
      await resolveReference(artifacts, {
        artifactId: artifact.id,
        path: "link",
      })
    ).toMatchObject({ entry: { target: "index.html", type: "symlink" } });
    expect(
      await resolveReference(artifacts, {
        artifactId: artifact.id,
        path: "missing.html",
      })
    ).toMatchObject({ entry: null, path: "missing.html", status: "available" });
  });

  it("reports missing identities and rejects Content from another artifact", async () => {
    const artifacts = system();
    const first = await artifacts.create({ name: "First", type: "text/plain" });
    const second = await artifacts.create({
      entries: { "a.txt": { bytes: "a" } },
      name: "Second",
      type: "text/plain",
    });
    expect(
      await resolveReference(artifacts, {
        artifactId: artifactIdSchema.parse("missing"),
      })
    ).toEqual({ reason: "artifact-missing", status: "unavailable" });
    expect(
      await resolveReference(artifacts, {
        artifactId: first.id,
        contentId: contentIdSchema.parse("missing"),
      })
    ).toEqual({ reason: "content-missing", status: "unavailable" });
    expect(
      await resolveReference(artifacts, {
        artifactId: first.id,
        contentId: required(second.contentId),
      })
    ).toEqual({ reason: "content-mismatch", status: "unavailable" });
  });

  it.each(["generating", "failed"] as const)(
    "retains identity while %s and refuses explicit unusable Content",
    async (state) => {
      const artifacts = system();
      const artifact = await artifacts.create({
        entries: {},
        name: "Pending",
        type: "text/plain",
      });
      const content: Content = { ...required(artifact.content), state };
      const reader = {
        get: () => Promise.resolve({ ...artifact, content }),
        getContent: () => Promise.resolve({ ...content, artifact }),
      };
      expect(
        await resolveReference(reader, { artifactId: artifact.id })
      ).toMatchObject({ content: null, status: "available" });
      expect(
        await resolveReference(reader, {
          artifactId: artifact.id,
          contentId: content.id,
        })
      ).toEqual({ reason: "content-unusable", status: "unavailable" });
    }
  );

  it.each(["", "../secret", "/absolute", "a/../b", "a\\b", "a\0b", "a//b"])(
    "refuses invalid path %j",
    async (path) => {
      const artifacts = system();
      const artifact = await artifacts.create({ name: "Empty", type: "files" });
      expect(
        await resolveReference(artifacts, { artifactId: artifact.id, path })
      ).toEqual({ reason: "path-invalid", status: "unavailable" });
    }
  );

  it("reports a broken declared entry instead of falling back to another file", async () => {
    const artifacts = system();
    const artifact = await artifacts.create({
      entries: { "index.html": { bytes: "page" } },
      name: "Broken",
      type: "text/html",
    });
    const reader = {
      get: () =>
        Promise.resolve({
          ...artifact,
          content: {
            ...required(artifact.content),
            metadata: { entry: "missing.html" },
          },
        }),
      getContent: artifacts.getContent.bind(artifacts),
    };
    expect(await resolveReference(reader, { artifactId: artifact.id })).toEqual(
      { reason: "entry-missing", status: "unavailable" }
    );
  });
});
