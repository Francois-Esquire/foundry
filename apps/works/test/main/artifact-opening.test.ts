import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryArtifactStore } from "@foundry/artifacts";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { EditorPreferences } from "~/main/artifacts/editor-preferences";
import { THUMBNAIL_MAX_BYTES } from "~/main/artifacts/explorer";
import { installEditorModule } from "../helpers/artifact-editors";
import { fakeClient, fakeStorage, openFakeVault } from "../helpers/fake-api";

const UUID = /^[0-9a-f-]{36}$/;

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "works-artifact-opening-"));
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function setup(preferences?: EditorPreferences) {
  const storage = fakeStorage(new InMemoryArtifactStore(), preferences);
  const client = fakeClient(await openFakeVault(), storage.modules, {
    artifacts: storage.explorer,
  });
  return { client, storage };
}

function markdownNotes(storage: ReturnType<typeof fakeStorage>) {
  return storage.artifacts.create({
    entries: { "notes.md": { bytes: "# Notes", mime: "text/markdown" } },
    name: "Notes",
    type: "text/markdown",
  });
}

it("resolves a Module Artifact by ID to its Module, though the listing leaves it out", async () => {
  const { client, storage } = await setup();
  const module = await storage.modules.create("Hidden module");

  expect(await client.artifacts.list()).toEqual([]);
  expect(await client.artifacts.resolve({ id: module.artifactId })).toEqual({
    kind: "module",
    moduleId: module.id,
  });
});

it("keeps an unsupported Artifact openable with no invented editor", async () => {
  const { client, storage } = await setup();
  const report = await storage.artifacts.create({
    entries: { "report.pdf": { bytes: "%PDF", mime: "application/pdf" } },
    name: "Report",
    type: "application/pdf",
  });

  expect(await client.artifacts.resolve({ id: report.id })).toMatchObject({
    candidates: [],
    entry: { mime: "application/pdf", path: "report.pdf" },
    kind: "editors",
    match: "none",
    mime: "application/pdf",
    preferred: null,
  });
});

it("finds editors in strict releases: the installed one, else the newest", async () => {
  const { client, storage } = await setup();
  await storage.modules.create("Legacy starter");
  // An imported or never-opened Module offers its newest release's editors.
  const imported = await installEditorModule(
    storage,
    "Not installed",
    [{ mimeTypes: ["text/markdown"], mode: "write", view: "edit" }],
    { installed: false }
  );
  const reader = await installEditorModule(storage, "Reader", [
    { mimeTypes: ["text/markdown", "text/plain"], mode: "read", view: "read" },
  ]);
  const notes = await markdownNotes(storage);

  expect(await client.artifacts.resolve({ id: notes.id })).toMatchObject({
    candidates: [
      {
        mode: "write",
        moduleId: imported.id,
        moduleName: "Not installed",
        view: "edit",
        viewTitle: "Not installed edit",
      },
      {
        mode: "read",
        moduleId: reader.id,
        moduleName: "Reader",
        view: "read",
        viewTitle: "Reader read",
      },
    ],
    contentId: notes.content?.id,
    match: "type",
  });
});

it("asks for an entry when a multi-file Artifact declares none, then resolves the chosen one", async () => {
  const { client, storage } = await setup();
  const bundle = await storage.artifacts.create({
    entries: {
      "a.md": { bytes: "# A", mime: "text/markdown" },
      "b.json": { bytes: "{}", mime: "application/json" },
    },
    name: "Bundle",
    type: "application/vnd.example.bundle",
  });
  const declared = await storage.artifacts.create({
    entries: {
      "a.md": { bytes: "# A", mime: "text/markdown" },
      "b.json": { bytes: "{}", mime: "application/json" },
    },
    metadata: { entry: "b.json" },
    name: "Declared",
    type: "application/vnd.example.bundle",
  });

  expect(await client.artifacts.resolve({ id: bundle.id })).toMatchObject({
    entries: [{ path: "a.md" }, { path: "b.json" }],
    kind: "entries",
  });
  expect(
    await client.artifacts.resolve({ entry: "a.md", id: bundle.id })
  ).toMatchObject({
    entry: { path: "a.md" },
    kind: "editors",
    mime: "text/markdown",
  });
  expect(await client.artifacts.resolve({ id: declared.id })).toMatchObject({
    entry: { path: "b.json" },
    kind: "editors",
  });
  await expect(
    client.artifacts.resolve({ entry: "gone.md", id: bundle.id })
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

it("reports an Artifact without files as empty and an unknown ID as not found", async () => {
  const { client, storage } = await setup();
  const empty = await storage.artifacts.create({
    name: "Empty",
    type: "text/plain",
  });

  expect(await client.artifacts.resolve({ id: empty.id })).toMatchObject({
    kind: "empty",
  });
  await expect(
    client.artifacts.resolve({ id: "missing" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("remembers the choice between several editors across restarts", async () => {
  const file = path.join(directory, "editor-preferences.json");
  const { client, storage } = await setup(new EditorPreferences({ file }));
  await installEditorModule(storage, "Alpha", [
    { mimeTypes: ["text/markdown"], mode: "write", view: "edit" },
  ]);
  const beta = await installEditorModule(storage, "Beta", [
    { mimeTypes: ["text/markdown"], mode: "read", view: "preview" },
  ]);
  const notes = await markdownNotes(storage);

  const first = await client.artifacts.resolve({ id: notes.id });
  expect(first).toMatchObject({ preferred: null });
  if (first.kind !== "editors") {
    throw new Error("expected editors");
  }
  expect(first.candidates.map((found) => found.moduleName)).toEqual([
    "Alpha",
    "Beta",
  ]);

  const request = await client.artifacts.open({
    contentId: first.contentId,
    entry: "notes.md",
    id: notes.id,
    moduleId: beta.id,
    view: "preview",
  });
  expect(request).toEqual({
    artifactId: notes.id,
    binding: expect.stringMatching(UUID),
    contentId: first.contentId,
    entry: "notes.md",
    mode: "read",
    moduleId: beta.id,
    view: "preview",
  });
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    format: "works.editor-preferences/1",
    preferences: { "text/markdown": { moduleId: beta.id, view: "preview" } },
  });

  expect(await client.artifacts.resolve({ id: notes.id })).toMatchObject({
    preferred: { moduleId: beta.id, view: "preview" },
  });
  // A restart reads the same choice back from host-owned Works state.
  expect(await new EditorPreferences({ file }).all()).toEqual({
    "text/markdown": { moduleId: beta.id, view: "preview" },
  });
});

it("opens files when the editor choices file is unreadable, and asks again", async () => {
  const file = path.join(directory, "editor-preferences.json");
  await writeFile(file, "{ not json");
  const quiet = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  onTestFinished(() => quiet.mockRestore());
  const { client, storage } = await setup(new EditorPreferences({ file }));
  await installEditorModule(storage, "Alpha", [
    { mimeTypes: ["text/markdown"], mode: "write", view: "edit" },
  ]);
  const beta = await installEditorModule(storage, "Beta", [
    { mimeTypes: ["text/markdown"], mode: "read", view: "preview" },
  ]);
  const notes = await markdownNotes(storage);

  const resolved = await client.artifacts.resolve({ id: notes.id });
  expect(resolved).toMatchObject({ kind: "editors", preferred: null });
  if (resolved.kind !== "editors") {
    throw new Error("expected editors");
  }
  await client.artifacts.open({
    contentId: resolved.contentId,
    entry: "notes.md",
    id: notes.id,
    moduleId: beta.id,
    view: "preview",
  });
  // The next choice replaces what could not be read.
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    format: "works.editor-preferences/1",
    preferences: { "text/markdown": { moduleId: beta.id, view: "preview" } },
  });
});

it("does not remember a choice when only one editor matched", async () => {
  const file = path.join(directory, "editor-preferences.json");
  const { client, storage } = await setup(new EditorPreferences({ file }));
  const alpha = await installEditorModule(storage, "Alpha", [
    { mimeTypes: ["text/markdown"], mode: "write", view: "edit" },
  ]);
  const notes = await markdownNotes(storage);

  await client.artifacts.open({
    contentId: notes.content?.id ?? "",
    entry: "notes.md",
    id: notes.id,
    moduleId: alpha.id,
    view: "edit",
  });
  await expect(readFile(file, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses to open stale Content or an editor that does not match", async () => {
  const { client, storage } = await setup();
  const alpha = await installEditorModule(storage, "Alpha", [
    { mimeTypes: ["text/markdown"], mode: "write", view: "edit" },
  ]);
  const notes = await markdownNotes(storage);
  const contentId = notes.content?.id ?? "";

  await expect(
    client.artifacts.open({
      contentId,
      entry: "notes.md",
      id: notes.id,
      moduleId: alpha.id,
      view: "home",
    })
  ).rejects.toMatchObject({ code: "CONFLICT" });
  if (!notes.content) {
    throw new Error("expected Content");
  }
  await storage.artifacts.revise({
    artifactId: notes.id,
    contentId: notes.content.id,
    expectedUpdatedAt: notes.content.updatedAt,
  });
  await expect(
    client.artifacts.open({
      contentId,
      entry: "notes.md",
      id: notes.id,
      moduleId: alpha.id,
      view: "edit",
    })
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

it("serves small stored images as thumbnails and nothing for other files", async () => {
  const { client, storage } = await setup();
  const pixel = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const photo = await storage.artifacts.create({
    entries: { "photo.png": { bytes: pixel, mime: "image/png" } },
    name: "Photo",
    type: "image/png",
  });
  const page = await storage.artifacts.create({
    entries: {
      "cover.webp": { bytes: pixel, mime: "image/webp" },
      "index.html": { bytes: "<p>Hi</p>", mime: "text/html" },
    },
    metadata: { thumbnail: "cover.webp" },
    name: "Page",
    type: "text/html",
  });
  const huge = await storage.artifacts.create({
    entries: {
      "huge.png": {
        bytes: new Uint8Array(THUMBNAIL_MAX_BYTES + 1),
        mime: "image/png",
      },
    },
    name: "Huge",
    type: "image/png",
  });
  const notes = await markdownNotes(storage);

  const listed = Object.fromEntries(
    (await client.artifacts.list()).map((item) => [item.name, item.thumbnail])
  );
  expect(listed).toEqual({
    Huge: false,
    Notes: false,
    Page: true,
    Photo: true,
  });
  const base64 = Buffer.from(pixel).toString("base64");
  expect(await client.artifacts.thumbnail({ id: photo.id })).toEqual({
    url: `data:image/png;base64,${base64}`,
  });
  expect(await client.artifacts.thumbnail({ id: page.id })).toEqual({
    url: `data:image/webp;base64,${base64}`,
  });
  expect(await client.artifacts.thumbnail({ id: huge.id })).toBeNull();
  expect(await client.artifacts.thumbnail({ id: notes.id })).toBeNull();
});
