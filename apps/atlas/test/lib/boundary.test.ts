import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ownerBoundary } from "../../src/lib/boundary";

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "semantic-surface-boundary-"));
  tempRoots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return realpathSync(root);
}

const manifest = (name: string) => JSON.stringify({ name });

describe("ownerBoundary", () => {
  it("folds a manifest outside the workspace patterns into its enclosing package", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
      }),
      "packages/a/nested/lib.ts": "",
      "packages/a/nested/package.json": manifest("@x/nested"),
      "packages/a/package.json": manifest("@x/a"),
      "packages/a/src/index.ts": "",
      "scripts/x.ts": "",
    });
    const owner = (file: string) => ownerBoundary(root, join(root, file));
    expect(owner("packages/a/src/index.ts")).toBe("@x/a");
    expect(owner("packages/a/nested/lib.ts")).toBe("@x/a");
    expect(owner("scripts/x.ts")).toBe("<root>");
  });

  it("uses the nearest manifest when the root declares no workspaces", () => {
    const root = fixture({
      "lib/inner/a.ts": "",
      "lib/inner/package.json": manifest("inner"),
      "package.json": manifest("root"),
    });
    expect(ownerBoundary(root, join(root, "lib/inner/a.ts"))).toBe("inner");
  });
});
