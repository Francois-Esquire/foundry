import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { workingTree } from "../../src/lib/working-tree";
import { commitFixture } from "../helpers/commit-fixture";

let directory: string;

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "atlas-tree-")));
});

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

it("lists every dirty file by its path as written, spaces, quotes, and non-ASCII names included", () => {
  const root = join(directory, "repository");
  mkdirSync(join(root, "src"), { recursive: true });
  for (const name of ["with space.ts", "café.ts", 'say "hi".ts', "old.ts"]) {
    writeFileSync(join(root, "src", name), "export const a = 1;\n");
  }
  commitFixture(root);
  for (const name of ["with space.ts", "café.ts", 'say "hi".ts']) {
    writeFileSync(join(root, "src", name), "export const a = 2;\n");
  }
  writeFileSync(join(root, "src", "new file.ts"), "export const b = 1;\n");
  renameSync(join(root, "src/old.ts"), join(root, "src/renamed é.ts"));
  execFileSync("git", ["add", "-A", "src/old.ts", "src/renamed é.ts"], {
    cwd: root,
  });
  const tree = workingTree(root);
  expect(tree.kind).toBe("repository");
  expect(tree.kind === "repository" && [...tree.dirty].sort()).toEqual([
    "src/café.ts",
    "src/new file.ts",
    "src/renamed é.ts",
    'src/say "hi".ts',
    "src/with space.ts",
  ]);
  // Relative to the workspace root, which may sit below the repository's.
  expect(workingTree(join(root, "src"))).toEqual({
    dirty: expect.arrayContaining(["with space.ts", "café.ts"]),
    kind: "repository",
  });
});

it("tells a directory outside any repository from one in a repository", () => {
  const outside = join(directory, "outside");
  mkdirSync(outside);
  expect(workingTree(outside)).toEqual({ kind: "not-a-repository" });
});
