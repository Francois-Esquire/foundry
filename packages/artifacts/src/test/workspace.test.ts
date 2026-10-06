import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceChange } from "@foundry/workspaces";
import { WorkspaceSourceUnavailableError } from "@foundry/workspaces";
import { describe, expect, it, vi } from "vitest";

import { ArtifactNotFoundError, artifactIdSchema } from "../index";
import { fixture } from "./helpers/directory";
import { required } from "./helpers/required";

describe("loading Artifact directories", () => {
  it("discovers created Artifacts and loads distinct directories through one system", async () => {
    const { artifacts, artifact, system, catalog, root, load } = await fixture({
      "first.md": { bytes: "first" },
    });
    const second = await artifacts.create({
      entries: { "second.md": { bytes: "second" } },
      name: "Second",
      type: "text/plain",
    });
    expect((await artifacts.list()).items.map((item) => item.id)).toContain(
      second.id
    );
    const firstWorkspace = await load();
    const secondWorkspace = await system.load({ artifactId: second.id });
    expect(firstWorkspace.id).not.toBe(secondWorkspace.id);
    expect((await load()).id).toBe(firstWorkspace.id);
    expect(await catalog.getWorkspace(firstWorkspace.id)).toMatchObject({
      path: join(root, artifact.id),
      source: "artifact",
      sourceId: artifact.id,
    });
    expect(
      await readFile(join(secondWorkspace.root, "second.md"), "utf8")
    ).toBe("second");
  });

  it("creates no Workspace for a missing or archived Artifact", async () => {
    const { artifacts, artifact, system, load } = await fixture();
    await expect(system.load({ artifactId: "missing" })).rejects.toBeInstanceOf(
      ArtifactNotFoundError
    );
    await artifacts.archive(artifact.id);
    await expect(load()).rejects.toBeInstanceOf(
      WorkspaceSourceUnavailableError
    );
    expect(await system.list()).toEqual({ items: [], total: 0 });
  });

  it("keeps the previous catalog after archive or hard deletion", async () => {
    const { artifacts, artifact, load } = await fixture({
      "kept.md": { bytes: "kept" },
    });
    const workspace = await load();
    await artifacts.archive(artifact.id);
    expect((await workspace.refresh()).source.kind).toBe("unavailable");
    await artifacts.delete(artifact.id);
    const view = await workspace.refresh();
    expect(view.source.kind).toBe("unavailable");
    expect(view.workspace.fileCount).toBe(1);
  });

  it("removing a Workspace leaves the Artifact untouched", async () => {
    const { artifacts, artifact, load } = await fixture({
      "a.md": { bytes: "a" },
    });
    await (await load()).remove();
    expect(await artifacts.get(artifact.id)).toEqual(artifact);
  });
});

describe("bidirectional changes", () => {
  it("removes previous working files when replaced by catalog-only special entries", async () => {
    const { artifacts, artifact, load } = await fixture({
      device: { bytes: "old device" },
      pipe: { bytes: "old pipe" },
      socket: { bytes: "old socket" },
    });
    const workspace = await load();
    await artifacts.write({
      artifactId: artifact.id,
      changes: {
        put: {
          device: { type: "device" },
          pipe: { type: "pipe" },
          socket: { type: "socket" },
        },
      },
    });
    for (const path of ["pipe", "socket", "device"]) {
      await expect(lstat(join(workspace.root, path))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(await workspace.scan()).toEqual(
      expect.arrayContaining([
        { name: "pipe", path: "pipe", type: "pipe" },
        { name: "socket", path: "socket", type: "socket" },
        { name: "device", path: "device", type: "device" },
      ])
    );
  });

  it("updates editable Content in place and emits one event for a Workspace save", async () => {
    const { artifacts, artifact, system, load } = await fixture({
      "notes.md": { bytes: "before", mime: "text/markdown" },
    });
    const workspace = await load();
    const [file] = await workspace.files();
    const events: WorkspaceChange[] = [];
    system.on("change", (event) => {
      events.push(event);
    });
    const result = await workspace.save({
      expectedDigest: required(file).digest,
      fileId: required(file).id,
      text: "after",
    });
    expect(result).toMatchObject({ catalog: "current", kind: "saved" });
    const current = await artifacts.get(artifact.id);
    expect(current?.contentId).toBe(artifact.contentId);
    expect(current?.content?.tree["notes.md"]).toMatchObject({
      mime: "text/markdown",
    });
    expect(await readFile(join(workspace.root, "notes.md"), "utf8")).toBe(
      "after"
    );
    await workspace.refresh();
    expect(events.map((event) => event.action)).toEqual(["change"]);
    expect(await workspace.read(required(file).id)).toMatchObject({
      kind: "text",
      text: "after",
    });
  });

  it("Artifact writes update disk before returning and reconcile add/change/delete once", async () => {
    const { artifacts, artifact, system, load } = await fixture({
      "drop.md": { bytes: "drop" },
      "keep.md": { bytes: "old" },
    });
    const workspace = await load();
    const events: WorkspaceChange[] = [];
    system.on("change", (event) => {
      events.push(event);
    });
    await artifacts.write({
      artifactId: artifact.id,
      changes: {
        put: { "keep.md": { bytes: "new" }, "new.md": { bytes: "new file" } },
        remove: ["drop.md"],
      },
    });
    expect(await readFile(join(workspace.root, "keep.md"), "utf8")).toBe("new");
    await expect(readFile(join(workspace.root, "drop.md"))).rejects.toThrow();
    await workspace.refresh();
    await workspace.refresh();
    expect(
      events.map(({ action, entry }) => [action, entry.path]).sort()
    ).toEqual([
      ["add", "new.md"],
      ["change", "keep.md"],
      ["delete", "drop.md"],
    ]);
  });

  it("returns current text on conflict and preserves a newer Artifact write", async () => {
    const { artifacts, artifact, load } = await fixture({
      "notes.md": { bytes: "before" },
    });
    const workspace = await load();
    const [file] = await workspace.files();
    await artifacts.write({
      artifactId: artifact.id,
      changes: { put: { "notes.md": { bytes: "theirs" } } },
    });
    expect(
      await workspace.save({
        expectedDigest: required(file).digest,
        fileId: required(file).id,
        text: "mine",
      })
    ).toMatchObject({ current: { text: "theirs" }, kind: "conflict" });
  });

  it("reports removed files as stale and archived sources as failed", async () => {
    const { artifacts, artifact, load } = await fixture({
      "notes.md": { bytes: "before" },
    });
    const workspace = await load();
    const [file] = await workspace.files();
    await artifacts.write({
      artifactId: artifact.id,
      changes: { remove: ["notes.md"] },
    });
    expect(
      await workspace.save({
        expectedDigest: required(file).digest,
        fileId: required(file).id,
        text: "mine",
      })
    ).toMatchObject({ kind: "stale" });
    await artifacts.archive(artifact.id);
    expect(
      await workspace.save({
        expectedDigest: required(file).digest,
        fileId: required(file).id,
        text: "mine",
      })
    ).toMatchObject({ kind: "failed" });
  });

  it("observes external edits, additions and deletions through Artifact operations", async () => {
    const { artifacts, artifact, load } = await fixture(
      { "drop.md": { bytes: "drop" }, "notes.md": { bytes: "before" } },
      true
    );
    const workspace = await load();
    await writeFile(join(workspace.root, "notes.md"), "external");
    await writeFile(join(workspace.root, "new.md"), "added");
    await rm(join(workspace.root, "drop.md"));
    await vi.waitFor(
      async () => {
        const current = await artifacts.get(artifact.id);
        expect(
          new TextDecoder().decode(
            required(
              await artifacts.readFile(
                required(required(current).contentId),
                "notes.md"
              )
            ).blob
          )
        ).toBe("external");
        expect(current?.content?.tree).toHaveProperty("new.md");
        expect(current?.content?.tree).not.toHaveProperty("drop.md");
      },
      { timeout: 4000 }
    );
  });

  it("restores frozen files after an external overwrite", async () => {
    const { artifacts, artifact, load } = await fixture(
      { "notes.md": { bytes: "frozen" } },
      true
    );
    await artifacts.freeze(required(artifact.contentId));
    const workspace = await load();
    await writeFile(join(workspace.root, "notes.md"), "external");
    await vi.waitFor(
      async () => {
        expect(await readFile(join(workspace.root, "notes.md"), "utf8")).toBe(
          "frozen"
        );
      },
      { timeout: 4000 }
    );
  });

  it("startup recovery makes Artifact records authoritative", async () => {
    const { artifact, filesystem, load } = await fixture(
      { "notes.md": { bytes: "authoritative" } },
      true
    );
    const workspace = await load();
    await writeFile(join(workspace.root, "notes.md"), "uncommitted");
    await filesystem.recover();
    expect(await readFile(join(workspace.root, "notes.md"), "utf8")).toBe(
      "authoritative"
    );
    expect((await filesystem.resolve({ artifactId: artifact.id })).path).toBe(
      workspace.root
    );
  });

  it("restores a directory removed outside the filesystem", async () => {
    const { artifacts, artifact, load } = await fixture({
      "notes.md": { bytes: "kept" },
    });
    const workspace = await load();
    await rm(workspace.root, { force: true, recursive: true });
    await vi.waitFor(
      async () => {
        expect(await readFile(join(workspace.root, "notes.md"), "utf8")).toBe(
          "kept"
        );
      },
      { timeout: 4000 }
    );
    expect(await artifacts.get(artifact.id)).toEqual(artifact);
  });

  it("filesystem root deletion removes the Artifact", async () => {
    const { artifacts, artifact, filesystem, load } = await fixture({
      "notes.md": { bytes: "a" },
    });
    await filesystem.remove((await load()).root);
    expect(await artifacts.get(artifact.id)).toBeNull();
  });

  it("rejects paths outside the configured storage root", async () => {
    const { filesystem, root } = await fixture();
    await expect(
      filesystem.writeFile(join(root, "..", "outside"), "bad")
    ).rejects.toThrow();
    await expect(
      filesystem.resolve({ artifactId: artifactIdSchema.parse("missing") })
    ).rejects.toThrow();
  });
});
