import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileTooLargeError } from "@foundry/artifacts";
import { afterEach, expect, it } from "vitest";
import { openModuleLibrary } from "~/main/modules/library";
import { moduleDirectory, moduleFolder } from "~/main/modules/local-library";
import { openTestLocalLibrary } from "../helpers/source-saves";
import { DISK_TEST_TIMEOUT_MS } from "../helpers/timeouts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), "works-module-folder-"));
  roots.push(root);
  return root;
}

const APP = "packages/app/src/App.tsx";

/** Every stored blob record, as JSON keeps it. */
async function blobRecords(root: string) {
  const records = JSON.parse(
    await readFile(path.join(root, ".library", "artifacts.json"), "utf8")
  ) as { blobs: Record<string, unknown>[] };
  return records.blobs;
}
const blobFileNames = async (root: string) =>
  (await readdir(path.join(root, ".library", "blobs"))).sort();

/** Puts a folder back the way Works wrote it before `source/` existed. */
async function legacyLayout(root: string, id: string) {
  const folder = moduleFolder(root, id);
  for (const name of await readdir(folder.source)) {
    await rename(path.join(folder.source, name), path.join(folder.root, name));
  }
  await rm(folder.source, { recursive: true });
  const marker = path.join(
    root,
    ".library",
    "workspaces",
    `${moduleDirectory(id)}.json`
  );
  const { layout: _layout, ...legacy } = JSON.parse(
    await readFile(marker, "utf8")
  ) as Record<string, unknown>;
  await writeFile(marker, JSON.stringify(legacy));
  return { folder, marker };
}

it("keeps new file bytes in backing files and only references in the records", {
  timeout: DISK_TEST_TIMEOUT_MS,
}, async () => {
  const root = await temporary();
  const { library } = await openTestLocalLibrary(root);
  const module = await library.create("Backed");
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("Source missing");
  }
  await library.saveSource(
    module.id,
    { ...details.source, [APP]: "a new unique payload" },
    details.binding
  );
  const blobs = await blobRecords(root);
  expect(blobs.length).toBeGreaterThan(0);
  for (const blob of blobs) {
    expect(blob).toHaveProperty("path");
    expect(blob).not.toHaveProperty("bytes");
  }
  const files = await blobFileNames(root);
  expect(files).toEqual(blobs.map((blob) => blob.path).sort());
  expect(
    await readFile(path.join(root, ".library", "artifacts.json"), "utf8")
  ).not.toContain("a new unique payload");
  expect(
    (await (await openTestLocalLibrary(root)).library.details(module.id))
      ?.source[APP]
  ).toBe("a new unique payload");
});

it("reads records whose bytes are inline and backs only new payloads with files", {
  timeout: DISK_TEST_TIMEOUT_MS,
}, async () => {
  const root = await temporary();
  const legacy = path.join(root, "profile");
  const original = await openModuleLibrary(legacy).create("Inline");
  const modules = path.join(root, "modules");
  const { library } = await openTestLocalLibrary(modules, {
    legacyUserData: legacy,
  });
  const details = await library.details(original.id);
  if (!details?.binding) {
    throw new Error("Source missing");
  }
  expect(details.source[APP]).toContain("Inline");
  const inline = (await blobRecords(modules)).filter((blob) => "bytes" in blob);
  expect(inline.length).toBeGreaterThan(0);
  expect(await blobFileNames(modules)).toEqual([]);

  await library.saveSource(
    original.id,
    { ...details.source, [APP]: "saved after files were enabled" },
    details.binding
  );
  const blobs = await blobRecords(modules);
  // Earlier inline bytes are not relocated; the new payload is a file.
  expect(blobs.filter((blob) => "bytes" in blob).length).toBeGreaterThan(0);
  expect(blobs.filter((blob) => "path" in blob)).toHaveLength(1);
  expect(await blobFileNames(modules)).toHaveLength(1);
  expect((await library.details(original.id))?.source[APP]).toBe(
    "saved after files were enabled"
  );
});

it("refuses a file over the maximum size and keeps no backing file for it", {
  timeout: DISK_TEST_TIMEOUT_MS,
}, async () => {
  const root = await temporary();
  const { library } = await openTestLocalLibrary(root, {
    maxFileBytes: 64 * 1024,
  });
  const module = await library.create("Limited");
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("Source missing");
  }
  const before = await blobFileNames(root);
  await expect(
    library.saveSource(
      module.id,
      { ...details.source, "large.txt": "x".repeat(64 * 1024 + 1) },
      details.binding
    )
  ).rejects.toBeInstanceOf(FileTooLargeError);
  expect(await blobFileNames(root)).toEqual(before);
  expect((await library.details(module.id))?.binding).toEqual(details.binding);
});

it("materializes buildable source under source/ with its Manifest", async () => {
  const root = await temporary();
  const { library } = await openTestLocalLibrary(root);
  const module = await library.create("Layout");
  const folder = moduleFolder(root, module.id);
  expect(await readdir(folder.root)).toEqual(["source"]);
  expect(
    JSON.parse(
      await readFile(path.join(folder.source, "foundry.module.json"), "utf8")
    )
  ).toHaveProperty("format");
  expect(await readFile(path.join(folder.source, APP), "utf8")).toContain(
    "Layout"
  );
});

it("keeps private data and release output out of the authoring and build source", async () => {
  const root = await temporary();
  const { library } = await openTestLocalLibrary(root);
  const module = await library.create("Separate");
  const folder = moduleFolder(root, module.id);
  await mkdir(path.join(folder.data), { recursive: true });
  await writeFile(path.join(folder.data, "notes.txt"), "private");
  await mkdir(path.join(folder.artifact, "outputs"), { recursive: true });
  await writeFile(path.join(folder.artifact, "outputs", "index.js"), "built");
  await writeFile(path.join(folder.root, "stray.txt"), "beside source/");
  const details = await library.details(module.id);
  const paths = Object.keys(details?.source ?? {});
  expect(paths).toContain("foundry.module.json");
  expect(paths).not.toContain("notes.txt");
  expect(paths.some((file) => file.includes("notes.txt"))).toBe(false);
  expect(paths.some((file) => file.startsWith("outputs/"))).toBe(false);
  expect(paths.some((file) => file.includes("stray.txt"))).toBe(false);
});

it("moves source written before source/ existed into it once, keeping pending disk edits", async () => {
  const root = await temporary();
  const first = await openTestLocalLibrary(root);
  const module = await first.library.create("Relocated");
  const { folder } = await legacyLayout(root, module.id);
  await writeFile(path.join(folder.root, APP), "edited before relocation");
  await writeFile(path.join(folder.root, ".env.local"), "LOCAL=kept");

  const { library } = await openTestLocalLibrary(root);
  const details = await library.details(module.id);
  expect(details?.source[APP]).toBe("edited before relocation");
  expect((await readdir(folder.root)).sort()).toEqual(["source"]);
  expect(await readFile(path.join(folder.source, APP), "utf8")).toBe(
    "edited before relocation"
  );
  expect(await readFile(path.join(folder.source, ".env.local"), "utf8")).toBe(
    "LOCAL=kept"
  );
  // Once moved, a later open leaves source/ as it is.
  await openTestLocalLibrary(root);
  expect((await readdir(folder.root)).sort()).toEqual(["source"]);
  expect(
    (await (await openTestLocalLibrary(root)).library.details(module.id))
      ?.source[APP]
  ).toBe("edited before relocation");
});

it("finishes a relocation that was interrupted part way", async () => {
  const root = await temporary();
  const first = await openTestLocalLibrary(root);
  const module = await first.library.create("Interrupted");
  const { folder, marker } = await legacyLayout(root, module.id);
  await writeFile(path.join(folder.root, APP), "pending edit");
  // As if Works stopped after moving one entry into the gathering directory.
  const holding = path.join(folder.root, ".relocating-source");
  await mkdir(holding);
  await rename(
    path.join(folder.root, "README.md"),
    path.join(holding, "README.md")
  );
  await writeFile(
    marker,
    JSON.stringify({
      ...(JSON.parse(await readFile(marker, "utf8")) as object),
      layout: "relocating",
    })
  );

  const { library } = await openTestLocalLibrary(root);
  const details = await library.details(module.id);
  expect(details?.source[APP]).toBe("pending edit");
  expect(details?.source["README.md"]).toBeDefined();
  expect(await readdir(folder.root)).toEqual(["source"]);
});

it("still refuses an unregistered workspace at the folder root", async () => {
  const root = await temporary();
  const first = await openTestLocalLibrary(root);
  const module = await first.library.create("Unregistered");
  const { folder, marker } = await legacyLayout(root, module.id);
  await rm(marker);
  await expect(openTestLocalLibrary(root)).rejects.toThrow(
    "unregistered workspace"
  );
  expect(await readFile(path.join(folder.root, APP), "utf8")).toContain(
    "Unregistered"
  );
});
