import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryWorkspaceStore } from "../memory-store";
import {
  workspaceEntrySchema,
  workspaceFileSchema,
  workspaceRegistrationSchema,
} from "../schema";
import { directorySystem } from "./helpers/directory-system";
import {
  artifactWorkspace,
  directoryRecord,
  fileRecord,
  newRoot,
} from "./helpers/fixtures";
import { makeRoot } from "./helpers/temp-roots";

async function cataloged() {
  const root = await makeRoot({
    "docs/guide.md": "# Guide",
    "README.md": "hello",
  });
  await symlink("README.md", join(root, "readme-link"));
  const store = new MemoryWorkspaceStore();
  const workspace = await directorySystem({ store }).load({ path: root });
  const registration = await workspace.registration();
  return { registration, root, store, workspace };
}

describe("record schemas", () => {
  it("describe every registration and entry the store holds", async () => {
    const { registration, store } = await cataloged();

    const stored = await store.getWorkspace(registration.id);
    expect(workspaceRegistrationSchema.parse(stored)).toEqual(stored);

    const entries = await store.listEntries(registration.id);
    expect(entries.map((entry) => entry.type).sort()).toEqual([
      "directory",
      "file",
      "file",
      "symlink",
    ]);
    for (const entry of entries) {
      expect(workspaceEntrySchema.parse(entry)).toEqual(entry);
    }
  });

  it("describe entries after the source changes and the catalog follows", async () => {
    const { registration, root, store, workspace } = await cataloged();
    await writeFile(join(root, "README.md"), "changed");
    await workspace.refresh();
    await workspace.rename("renamed");

    const stored = await store.getWorkspace(registration.id);
    expect(workspaceRegistrationSchema.parse(stored)).toEqual(stored);
    for (const file of await workspace.files()) {
      expect(workspaceFileSchema.parse(file)).toEqual(file);
    }
  });

  it("describe the records the store conformance suite commits", () => {
    const workspace = artifactWorkspace("artifact-1", newRoot("alpha"));
    expect(workspaceRegistrationSchema.parse(workspace)).toEqual(workspace);
    for (const entry of [
      directoryRecord(workspace.id, "docs"),
      fileRecord(workspace.id, { path: "docs/guide.md" }),
    ]) {
      expect(workspaceEntrySchema.parse(entry)).toEqual(entry);
    }
  });

  it("refuse fields and values a persisted record never has", async () => {
    const { workspace } = await cataloged();
    const [file] = await workspace.files();
    if (!file) {
      throw new Error("expected a File");
    }

    expect(workspaceFileSchema.safeParse({ ...file, extra: 1 }).success).toBe(
      false
    );
    expect(
      workspaceFileSchema.safeParse({ ...file, digest: "abc" }).success
    ).toBe(false);
    expect(
      workspaceFileSchema.safeParse({ ...file, path: "../outside" }).success
    ).toBe(false);
    expect(
      workspaceEntrySchema.safeParse({ ...file, type: "directory" }).success
    ).toBe(false);
  });
});
