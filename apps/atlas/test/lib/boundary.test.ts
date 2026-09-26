import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ownerBoundary } from "../../src/lib/boundary";

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "semantic-surface-boundary-")
  );
  tempRoots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return fs.realpathSync(root);
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
    const owner = (file: string) => ownerBoundary(root, path.join(root, file));
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
    expect(ownerBoundary(root, path.join(root, "lib/inner/a.ts"))).toBe(
      "inner"
    );
  });
});
