import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileRepresentation, StorageEntry } from "@foundry/core/storage";
import type { FileClassification } from "@foundry/lib/file-classification";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type WorkspaceEntry,
  type WorkspaceEntryId,
  type WorkspaceFile,
  type WorkspaceId,
  workspaceEntrySchema,
  workspaceFileSchema,
  workspaceRegistrationSchema,
} from "../schema";
import { MemoryWorkspaceStore } from "../store/memory";
import {
  artifactWorkspace,
  directoryRecord,
  fileRecord,
  hostWorkspace,
  newRoot,
} from "../testing/records";
import { directorySystem } from "./helpers/directory-system";
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

/** The record fields a Workspace adds to what the source observed. */
type EntryRecordKey = "createdAt" | "id" | "name" | "updatedAt" | "workspaceId";
/** An entry as core's storage node, without what classification adds. */
type StorageNodeOf<Entry> = Entry extends unknown
  ? Omit<Entry, EntryRecordKey | "extension" | "kind">
  : never;

describe("record types", () => {
  it("keep the id brands minted by casting", () => {
    expectTypeOf<WorkspaceId>().toEqualTypeOf<
      string & { readonly __brand: "WorkspaceId" }
    >();
    expectTypeOf<WorkspaceEntryId>().toEqualTypeOf<
      string & { readonly __brand: "WorkspaceEntryId" }
    >();
  });

  it("restate core's storage shapes exactly", () => {
    // `branded` compares core's union of intersections member by member.
    expectTypeOf<
      StorageNodeOf<WorkspaceEntry>
    >().branded.toEqualTypeOf<StorageEntry>();
    expectTypeOf<
      StorageNodeOf<WorkspaceFile>
    >().toEqualTypeOf<FileRepresentation>();
    expectTypeOf<
      Pick<WorkspaceFile, keyof FileClassification>
    >().toEqualTypeOf<FileClassification>();
  });
});

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
    expect(workspaceFileSchema.safeParse({ ...file, bytes: -1 }).success).toBe(
      false
    );
    expect(
      workspaceFileSchema.safeParse({ ...file, path: "../outside" }).success
    ).toBe(false);
    expect(
      workspaceEntrySchema.safeParse({ ...file, type: "directory" }).success
    ).toBe(false);
  });

  it("refuse entries core's storage rules refuse", () => {
    const workspace = hostWorkspace({ path: newRoot("alpha") });
    const docs = directoryRecord(workspace.id, "docs");
    const link = { ...docs, target: "docs", type: "symlink" };

    expect(workspaceEntrySchema.safeParse(link).success).toBe(true);
    expect(
      workspaceEntrySchema.safeParse({ ...link, target: "" }).success
    ).toBe(false);
    expect(
      workspaceEntrySchema.safeParse({ ...docs, path: "../docs" }).success
    ).toBe(false);
  });
});
