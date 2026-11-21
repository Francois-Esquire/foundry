import { lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactPlace,
  linkName,
  rebuildLinks,
  relinkArtifact,
} from "~/database/links";
import type { ArtifactFile, ResourceView } from "~/database/resources";
import { artifactBlobs } from "~/database/stores";
import { resourceLinks } from "~/layout";
import type { ResourceRef } from "~/lib/resources";
import { temporaryDirectory } from "./helpers/temporary";

const HERE = "here";

function ref(owner: string, id: string): ResourceRef {
  return { id, kind: "artifact", owner };
}

function viewOf(
  ...shown: (readonly {
    readonly ref: ResourceRef;
    readonly files: readonly ArtifactFile[];
  }[])[]
): ResourceView {
  let read = 0;
  let current = shown[0] ?? [];
  return {
    artifactFiles: (wanted: ResourceRef) =>
      Promise.resolve(
        current.find(
          (item) => item.ref.owner === wanted.owner && item.ref.id === wanted.id
        )?.files ?? []
      ),
    artifacts: () => {
      current = shown[Math.min(read, shown.length - 1)] ?? [];
      read += 1;
      return Promise.resolve(current.map((item) => ({ ref: item.ref })));
    },
  } as unknown as ResourceView;
}

async function arranged() {
  const home = temporaryDirectory("marbles-links-");
  const root = join(home, "workspace");
  const artifacts = join(home, "artifacts");
  const outside = join(home, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  for (const owner of [HERE, "one", "two"]) {
    const blobs = artifactBlobs(artifacts, owner);
    mkdirSync(blobs, { recursive: true });
    await writeFile(join(blobs, "blob"), `bytes of ${owner}`);
  }
  const linkOf = (shown: ResourceRef, path: string) =>
    join(resourceLinks(root, "artifact"), ...artifactPlace(shown, HERE), path);
  return { artifacts, linkOf, outside, root };
}

const FILE: readonly ArtifactFile[] = [{ blob: "blob", path: "file.txt" }];
const NESTED: readonly ArtifactFile[] = [
  { blob: "blob", path: "nested/file.txt" },
];

describe("link names", () => {
  it("never share a name, whatever the case, and never start with @ or name . or ..", () => {
    const names = ["Same", "same", "SAME", ".", "..", "@one", "a/b", "%41"];
    const encoded = names.map(linkName);
    expect(new Set(encoded.map((name) => name.toLowerCase())).size).toBe(
      names.length
    );
    for (const name of encoded) {
      expect(name.startsWith("@")).toBe(false);
      expect(name).not.toContain("/");
      expect([".", ".."]).not.toContain(name);
    }
  });

  it("put another owner's artifact under that owner, and this workspace's own at the top", () => {
    expect(artifactPlace(ref(HERE, "same"), HERE)).toEqual(["same"]);
    expect(artifactPlace(ref("one", "same"), HERE)).toEqual(["@one", "same"]);
  });
});

describe("links made from the database", () => {
  it("keep two owners' artifacts of the same id apart, and unlinking one leaves the other", async () => {
    const { artifacts, linkOf, root } = await arranged();
    const view = viewOf([
      { files: FILE, ref: ref("one", "same") },
      { files: FILE, ref: ref("two", "same") },
    ]);
    const report = await rebuildLinks({
      artifacts,
      root,
      view,
      workspace: HERE,
    });
    expect(report).toMatchObject({ kept: [], linked: 2, refused: [] });
    expect(await readFile(linkOf(ref("one", "same"), "file.txt"), "utf8")).toBe(
      "bytes of one"
    );
    await relinkArtifact({
      artifacts,
      files: [],
      ref: ref("two", "same"),
      root,
      workspace: HERE,
    });
    expect(await readFile(linkOf(ref("one", "same"), "file.txt"), "utf8")).toBe(
      "bytes of one"
    );
  });

  it("refuse an artifact directory that is a link, or a link inside one, and make nothing through it", async () => {
    const { artifacts, outside, root } = await arranged();
    const dir = resourceLinks(root, "artifact");
    mkdirSync(join(dir, "nested-in", "notes"), { recursive: true });
    symlinkSync(outside, join(dir, "notes"));
    symlinkSync(outside, join(dir, "nested-in", "notes", "nested"));
    const refused = await relinkArtifact({
      artifacts,
      files: NESTED,
      ref: ref(HERE, "notes"),
      root,
      workspace: HERE,
    });
    expect(refused).toMatchObject({
      linked: 0,
      refused: [".marbles/artifacts/notes"],
    });
    const view = viewOf([
      { files: NESTED, ref: ref(HERE, "notes") },
      { files: NESTED, ref: ref(HERE, "nested-in") },
    ]);
    const rebuilt = await rebuildLinks({
      artifacts,
      root,
      view,
      workspace: HERE,
    });
    expect(rebuilt.refused).toEqual([
      ".marbles/artifacts/notes/nested/file.txt",
    ]);
    expect([...rebuilt.kept].sort()).toEqual([
      ".marbles/artifacts/nested-in/notes/nested",
      ".marbles/artifacts/notes",
    ]);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(dir, "notes")).isSymbolicLink()).toBe(true);
  });

  it("keep a link Marbles did not make", async () => {
    const { artifacts, outside, root } = await arranged();
    const dir = resourceLinks(root, "artifact");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "shortcut"));
    const report = await rebuildLinks({
      artifacts,
      root,
      view: viewOf([]),
      workspace: HERE,
    });
    expect(report.kept).toEqual([".marbles/artifacts/shortcut"]);
    expect(await readlink(join(dir, "shortcut"))).toBe(outside);
  });

  it("keep a link whose target only spells a path under the artifacts and leads out of them", async () => {
    const { artifacts, root } = await arranged();
    const dir = resourceLinks(root, "artifact");
    const escaping = `${join(artifacts, "workspaces")}/../../outside`;
    mkdirSync(join(dir, "notes"), { recursive: true });
    symlinkSync(escaping, join(dir, "shortcut"));
    symlinkSync(escaping, join(dir, "notes", "file.txt"));
    const report = await relinkArtifact({
      artifacts,
      files: FILE,
      ref: ref(HERE, "notes"),
      root,
      workspace: HERE,
    });
    expect(report?.kept).toEqual([".marbles/artifacts/notes/file.txt"]);
    expect(await readlink(join(dir, "notes", "file.txt"))).toBe(escaping);
    const rebuilt = await rebuildLinks({
      artifacts,
      root,
      view: viewOf([]),
      workspace: HERE,
    });
    expect(rebuilt.kept).toEqual([
      ".marbles/artifacts/notes/file.txt",
      ".marbles/artifacts/shortcut",
    ]);
    expect(await readlink(join(dir, "shortcut"))).toBe(escaping);
  });

  it("converge when many rebuilds and updates run at once", async () => {
    const { artifacts, linkOf, root } = await arranged();
    const shown = [{ files: NESTED, ref: ref(HERE, "notes") }];
    await rebuildLinks({
      artifacts,
      root,
      view: viewOf(shown),
      workspace: HERE,
    });
    const runs = await Promise.allSettled([
      ...Array.from({ length: 10 }, () =>
        rebuildLinks({ artifacts, root, view: viewOf(shown), workspace: HERE })
      ),
      ...Array.from({ length: 10 }, () =>
        relinkArtifact({
          artifacts,
          files: NESTED,
          ref: ref(HERE, "notes"),
          root,
          workspace: HERE,
        })
      ),
    ]);
    expect(runs.filter((run) => run.status === "rejected")).toEqual([]);
    expect(
      await readFile(linkOf(ref(HERE, "notes"), "nested/file.txt"), "utf8")
    ).toBe(`bytes of ${HERE}`);
  });

  it("read the view again after reconciling, so a write during a rebuild is linked", async () => {
    const { artifacts, linkOf, root } = await arranged();
    const view = viewOf([], [{ files: FILE, ref: ref(HERE, "late") }]);
    await rebuildLinks({ artifacts, root, view, workspace: HERE });
    expect(await readFile(linkOf(ref(HERE, "late"), "file.txt"), "utf8")).toBe(
      `bytes of ${HERE}`
    );
  });
});
