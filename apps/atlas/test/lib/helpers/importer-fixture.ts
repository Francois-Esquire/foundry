import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commitFixture } from "../../helpers/commit-fixture";

/** The fixture package's name, at `packages/a`. */
export const PACKAGE = "@t/a";

/**
 * A committed one-package workspace in a temporary directory: `@t/a`, private,
 * with the root entrypoint `src/index.ts` and the subpath `./sub`
 * (`src/sub.ts`), plus `files`, by path under `packages/a`. Remove the
 * returned root when done.
 */
export function importerFixture(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atlas-importers-")));
  const write = (path: string, text: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write(
    "package.json",
    JSON.stringify({
      name: "importers-fixture",
      private: true,
      workspaces: ["packages/*"],
    })
  );
  write(
    "packages/a/package.json",
    JSON.stringify({
      exports: { ".": "./src/index.ts", "./sub": "./src/sub.ts" },
      name: PACKAGE,
      private: true,
    })
  );
  write("packages/a/src/sub.ts", "export const subMarker = 1;\n");
  for (const [path, text] of Object.entries(files)) {
    write(join("packages/a", path), text);
  }
  commitFixture(root);
  return root;
}
