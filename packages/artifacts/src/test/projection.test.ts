import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactManager } from "../manager";
import { InMemoryArtifactStore } from "../memory";
import { blobFiles } from "../node/blobs";
import { projectionMatches, stageProjection } from "../node/projection";
import { required } from "./helpers/required";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "artifact-projection-"));
  roots.push(root);
  const artifacts = new ArtifactManager({
    files: blobFiles(join(root, "blobs")),
    store: new InMemoryArtifactStore(),
  });
  const created = await artifacts.create({
    entries: {
      "outputs/app/index.js": { bytes: "export {};" },
      "outputs/index.html": { bytes: "<h1>Built</h1>" },
      "source/app.ts": { bytes: "source, never projected" },
    },
    name: "Release",
    type: "application/octet-stream",
  });
  const frozen = await artifacts.freeze(required(created.contentId));
  const projection = {
    artifacts,
    contentId: frozen.id,
    include: (path: string) =>
      path === "outputs" || path.startsWith("outputs/"),
  };
  return { artifacts, projection, root };
}

describe("Content projection", () => {
  it("stages exactly the projected entries of a frozen Content, read-only", async () => {
    const { projection, root } = await setup();
    const target = join(root, "projected");
    await stageProjection(projection, target);
    expect(await readdir(target)).toEqual(["outputs"]);
    expect((await readdir(join(target, "outputs"))).sort()).toEqual([
      "app",
      "index.html",
    ]);
    const html = join(target, "outputs", "index.html");
    expect(await readFile(html, "utf8")).toBe("<h1>Built</h1>");
    // biome-ignore lint/suspicious/noBitwiseOperators: Mode bits are a bitmask.
    expect((await stat(html)).mode & 0o777).toBe(0o444);
    expect(await projectionMatches(projection, target)).toBe(true);
  });

  it("notices a changed, added or missing file", async () => {
    const { projection, root } = await setup();
    const target = join(root, "projected");
    await stageProjection(projection, target);
    const html = join(target, "outputs", "index.html");
    await chmod(html, 0o644);
    await writeFile(html, "changed");
    expect(await projectionMatches(projection, target)).toBe(false);
    await rm(target, { recursive: true });
    expect(await projectionMatches(projection, target)).toBe(false);
    await stageProjection(projection, target);
    await writeFile(join(target, "outputs", "extra.js"), "added");
    expect(await projectionMatches(projection, target)).toBe(false);
  });

  it("refuses Content that is not frozen and a directory that already exists", async () => {
    const { artifacts, projection, root } = await setup();
    const working = await artifacts.create({
      entries: { "outputs/index.html": { bytes: "still editable" } },
      name: "Working",
      type: "application/octet-stream",
    });
    await expect(
      stageProjection(
        { ...projection, contentId: required(working.contentId) },
        join(root, "working")
      )
    ).rejects.toThrow("is not frozen");
    await stageProjection(projection, join(root, "projected"));
    await expect(
      stageProjection(projection, join(root, "projected"))
    ).rejects.toMatchObject({ code: "EEXIST" });
  });
});
