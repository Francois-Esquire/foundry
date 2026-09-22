import { withParentDirectories } from "@foundry/core/storage";
import { digestJson } from "@foundry/lib/digest";
import { describe, expect, it } from "vitest";

import { digestTree } from "../tree";

const file = {
  bytes: 3,
  digest: "a".repeat(64),
  mime: null,
  type: "file",
} as const;

describe("tree digests", () => {
  it("preserves legacy file-only digests when explicit parents are added", async () => {
    expect(await digestTree(withParentDirectories({ "src/file": file }))).toBe(
      await digestJson([["src/file", file.digest]])
    );
  });

  it("includes empty directories, special entry types, and link targets", async () => {
    const digests = await Promise.all([
      digestTree({}),
      digestTree({ item: { type: "directory" } }),
      digestTree({ item: { type: "socket" } }),
      digestTree({ item: { type: "device" } }),
      digestTree({ item: { type: "pipe" } }),
      digestTree({ item: { target: "one", type: "symlink" } }),
      digestTree({ item: { target: "two", type: "symlink" } }),
    ]);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("is independent of entry insertion order", async () => {
    expect(await digestTree({ a: { type: "directory" }, z: file })).toBe(
      await digestTree({ a: { type: "directory" }, z: file })
    );
  });
});
