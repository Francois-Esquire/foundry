import { lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkName, relinkArtifact } from "~/database/links";
import { artifactBlobs } from "~/database/local-artifacts";
import type { ArtifactFile } from "~/database/resources";
import { resourceLinks } from "~/layout";
import type { ResourceRef } from "~/lib/resources";
import { temporaryDirectory } from "./helpers/temporary";

const HERE = "here";

function ref(id: string): ResourceRef {
  return { id, kind: "artifact", owner: HERE };
}

async function arranged() {
  const home = temporaryDirectory("marbles-links-");
  const root = join(home, "workspace");
  const artifacts = join(home, "artifacts");
  const outside = join(home, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const blobs = artifactBlobs(artifacts, HERE);
  mkdirSync(blobs, { recursive: true });
  await writeFile(join(blobs, "blob"), `bytes of ${HERE}`);
  return { artifacts, outside, root };
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
});

describe("links made from the database", () => {
  it("refuse an artifact directory that is a link, and make nothing through it", async () => {
    const { artifacts, outside, root } = await arranged();
    const dir = resourceLinks(root, "artifact");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "notes"));
    const refused = await relinkArtifact({
      artifacts,
      files: NESTED,
      ref: ref("notes"),
      root,
    });
    expect(refused).toMatchObject({
      linked: 0,
      refused: [".marbles/artifacts/notes"],
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(dir, "notes")).isSymbolicLink()).toBe(true);
  });

  it("keep a link whose target only spells a path under the artifacts and leads out of them", async () => {
    const { artifacts, root } = await arranged();
    const dir = resourceLinks(root, "artifact");
    const escaping = `${join(artifacts, "workspaces")}/../../outside`;
    mkdirSync(join(dir, "notes"), { recursive: true });
    symlinkSync(escaping, join(dir, "notes", "file.txt"));
    const report = await relinkArtifact({
      artifacts,
      files: FILE,
      ref: ref("notes"),
      root,
    });
    expect(report?.kept).toEqual([".marbles/artifacts/notes/file.txt"]);
    expect(await readlink(join(dir, "notes", "file.txt"))).toBe(escaping);
  });

  it("converge when many updates run at once", async () => {
    const { artifacts, root } = await arranged();
    const dir = resourceLinks(root, "artifact");
    mkdirSync(dir, { recursive: true });
    const runs = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        relinkArtifact({ artifacts, files: NESTED, ref: ref("notes"), root })
      )
    );
    expect(runs.filter((run) => run.status === "rejected")).toEqual([]);
    expect(
      await readFile(join(dir, "notes", "nested", "file.txt"), "utf8")
    ).toBe(`bytes of ${HERE}`);
  });
});
