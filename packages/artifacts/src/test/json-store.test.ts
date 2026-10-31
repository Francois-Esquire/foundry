import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ArtifactManager } from "../index";
import { artifactFileSystem, blobFiles, JsonArtifactStore } from "../node";
import { describeArtifactManager } from "../testing/manager";
import { describeArtifactStore } from "../testing/store";

const root = mkdtempSync(join(tmpdir(), "artifact-json-"));
afterAll(() => rm(root, { force: true, recursive: true }));

const recordsPath = () => join(root, crypto.randomUUID(), "records.json");
const store = () => new JsonArtifactStore({ path: recordsPath() });

describeArtifactStore("JSON", store);
describeArtifactManager("JSON", store);

describe("JSON Artifact store persistence", () => {
  it("reopens committed Artifacts with dates and inline bytes intact", async () => {
    const path = recordsPath();
    const created = await new ArtifactManager({
      store: new JsonArtifactStore({ path }),
    }).create({
      entries: { "entry.md": { bytes: "# Hello", mime: "text/markdown" } },
      metadata: { entry: "entry.md" },
      name: "Hello",
      type: "text/markdown",
    });

    const reopened = new ArtifactManager({
      store: new JsonArtifactStore({ path }),
    });
    const artifact = await reopened.get(created.id);
    expect(artifact?.createdAt).toBeInstanceOf(Date);
    expect(artifact?.createdAt.getTime()).toBe(created.createdAt.getTime());
    if (!artifact?.content) {
      throw new Error("Expected Content");
    }
    const entry = await reopened.readRoot(artifact.content.id);
    expect(new TextDecoder().decode(entry?.blob)).toBe("# Hello");
  });

  it("keeps every write when two stores share one file", async () => {
    const path = recordsPath();
    const first = new ArtifactManager({
      store: new JsonArtifactStore({ path }),
    });
    const second = new ArtifactManager({
      store: new JsonArtifactStore({ path }),
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        (index % 2 === 0 ? first : second).create({
          name: `Entry ${String(index)}`,
          type: "text/markdown",
        })
      )
    );
    expect((await first.list({})).total).toBe(6);
    expect((await second.list({})).total).toBe(6);
  });

  it("stores file bytes as blob files beside the records", async () => {
    const directory = join(root, crypto.randomUUID());
    const artifacts = new ArtifactManager({
      files: blobFiles(join(directory, "blobs")),
      store: new JsonArtifactStore({ path: join(directory, "records.json") }),
    });
    await artifacts.create({
      entries: { "entry.md": { bytes: "# Blob" } },
      name: "Blob",
      type: "text/markdown",
    });
    const text = await readFile(join(directory, "records.json"), "utf8");
    expect(text).not.toContain("$bytes");
    expect(text).toContain('"path"');
  });

  it("reopens metadata shaped like its own date and byte tags unchanged", async () => {
    const path = recordsPath();
    const metadata = {
      at: { $date: "not a date" },
      escaped: { $object: { $bytes: "kept" } },
      marker: { $bytes: "not base64!" },
      nested: [{ $date: "2020-01-01T00:00:00.000Z" }],
    };
    const created = await new ArtifactManager({
      store: new JsonArtifactStore({ path }),
    }).create({
      entries: { "notes.txt": { bytes: "notes" } },
      metadata,
      name: "Tagged",
      type: "text/plain",
    });

    const reopened = new ArtifactManager({
      store: new JsonArtifactStore({ path }),
    });
    const artifact = await reopened.get(created.id);
    expect(artifact?.content?.metadata).toMatchObject(metadata);
  });

  it("runs post-commit work after releasing the store, so it can write again", async () => {
    const records = new JsonArtifactStore({ path: recordsPath() });
    const order: string[] = [];
    await records.transaction(async (transaction) => {
      transaction.afterCommit(async () => {
        await records.transaction(async () => {
          order.push("nested write");
        });
      });
      order.push("outer write");
    });
    expect(order).toEqual(["outer write", "nested write"]);
  }, 2000);

  it("discards post-commit work when the write fails", async () => {
    const records = new JsonArtifactStore({ path: recordsPath() });
    let ran = false;
    await expect(
      records.transaction(async (transaction) => {
        transaction.afterCommit(async () => {
          ran = true;
        });
        throw new Error("rolled back");
      })
    ).rejects.toThrow("rolled back");
    expect(ran).toBe(false);
  });

  it("applies commits to a bound directory before the mutation returns", async () => {
    const directory = join(root, crypto.randomUUID());
    const artifacts = new ArtifactManager({
      store: new JsonArtifactStore({ path: join(directory, "records.json") }),
    });
    const filesystem = artifactFileSystem({
      artifacts,
      root: join(directory, "files"),
    });
    try {
      const created = await artifacts.create({
        entries: { "entry.md": { bytes: "# Bound" } },
        name: "Bound",
        type: "text/markdown",
      });
      const { path } = await filesystem.resolve({ artifactId: created.id });
      expect(await readFile(join(path, "entry.md"), "utf8")).toBe("# Bound");
    } finally {
      await filesystem.close();
    }
  }, 2000);

  it("refuses an unreadable records file instead of starting empty", async () => {
    const path = recordsPath();
    const artifacts = new ArtifactManager({
      store: new JsonArtifactStore({ path }),
    });
    await artifacts.create({ name: "Kept", type: "text/plain" });
    await writeFile(path, "{ not json");
    await expect(artifacts.list({})).rejects.toThrow();
  });
});
