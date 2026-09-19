import type { StorageTree } from "@foundry/core/storage";
import {
  storageTree,
  validateStorageTree,
  withParentDirectories,
} from "@foundry/core/storage";
import { describe, expect, it } from "vitest";

const file = {
  bytes: 3,
  digest: "a".repeat(64),
  mime: null,
  type: "file",
} as const;

describe("shared storage trees", () => {
  it("preserves empty directories and all supported entry types without content", () => {
    const tree: StorageTree = {
      device: { type: "device" },
      empty: { type: "directory" },
      file,
      link: { target: "../missing", type: "symlink" },
      pipe: { type: "pipe" },
      socket: { type: "socket" },
    };
    expect(
      storageTree(
        Object.entries(tree).map(([path, node]) => ({ ...node, path }))
      )
    ).toEqual(tree);
  });

  it("adds only missing parents, including reserved object-property names", () => {
    const tree = withParentDirectories({
      "__proto__/constructor/file": file,
      empty: { type: "directory" },
    });
    expect(Object.keys(tree).sort()).toEqual([
      "__proto__",
      "__proto__/constructor",
      "__proto__/constructor/file",
      "empty",
    ]);
    expect(Object.getOwnPropertyDescriptor(tree, "__proto__")?.value).toEqual({
      type: "directory",
    });
    expect(() =>
      withParentDirectories({ dir: file, "dir/child": file })
    ).toThrow("Missing directory");
  });

  it.each([
    "",
    "/absolute",
    "../escape",
    "a/../b",
    "a//b",
    "a\\b",
    "a/",
    "a\0b",
  ])("rejects nonportable path %j", (path) => {
    expect(() => storageTree([{ ...file, path }])).toThrow(
      "Invalid storage path"
    );
  });

  it("rejects duplicates and incomplete trees", () => {
    expect(() =>
      storageTree([
        { ...file, path: "a" },
        { path: "a", type: "directory" },
      ])
    ).toThrow("Duplicate storage path");
    expect(() => storageTree([{ ...file, path: "missing/file" }])).toThrow(
      "Missing directory"
    );
  });

  it.each([
    null,
    { type: "other" },
    { ...file, digest: "invalid" },
    { ...file, bytes: -1 },
    { ...file, bytes: 1.5 },
    { ...file, mime: 1 },
    { ...file, target: "wrong" },
    { bytes: 1, type: "directory" },
    { digest: file.digest, type: "socket" },
    { target: "", type: "symlink" },
    { target: "bad\0target", type: "symlink" },
  ])("rejects malformed persisted node %j", (node) => {
    expect(() => {
      validateStorageTree({ bad: node } as unknown as StorageTree);
    }).toThrow();
  });
});
