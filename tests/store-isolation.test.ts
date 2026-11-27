import { existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageDirs,
  parseModuleImports,
  readManifest,
  sourceFiles,
} from "./helpers/scan";

const DRIZZLE_IMPORT = /^drizzle-orm(?:\/|$)/;
const LIBSQL_IMPORT = /^@libsql\/(?:client|$)/;
const NON_PRODUCTION_DIRS = ["node_modules", "dist", "test", "testing"];

const ALLOWED_DRIZZLE_FILES: Readonly<Record<string, readonly string[]>> = {
  lib: ["sqlite.ts"],
};
const DEFAULT_ALLOWED_DRIZZLE_FILES = ["store/sqlite.ts", "store/tables.ts"];

const ALL_PACKAGES = packageDirs().map((dir) => ({
  dir,
  manifest: readManifest(dir),
  name: basename(dir),
}));

describe("SQLite / Drizzle store isolation", () => {
  it.each(ALL_PACKAGES)(
    "keeps Drizzle confined and @libsql/* out of packages/$name/src",
    ({ dir, manifest, name }) => {
      const srcDir = join(dir, "src");
      if (!existsSync(srcDir)) {
        return;
      }

      const allowedDrizzle = new Set(
        ALLOWED_DRIZZLE_FILES[name] ?? DEFAULT_ALLOWED_DRIZZLE_FILES
      );
      const files = sourceFiles(srcDir, {
        extensions: [".ts", ".tsx"],
        skipDirs: NON_PRODUCTION_DIRS,
      });

      const drizzleViolations: string[] = [];
      const libsqlViolations: string[] = [];

      for (const file of files) {
        const rel = relative(srcDir, file).replaceAll("\\", "/");
        for (const { specifier } of parseModuleImports(file)) {
          if (DRIZZLE_IMPORT.test(specifier) && !allowedDrizzle.has(rel)) {
            drizzleViolations.push(`${rel} imports ${specifier}`);
          }
          if (LIBSQL_IMPORT.test(specifier)) {
            libsqlViolations.push(`${rel} imports ${specifier}`);
          }
        }
      }

      expect(drizzleViolations).toEqual([]);
      expect(libsqlViolations).toEqual([]);

      if (manifest.exports?.["./store/sqlite"] !== undefined) {
        expect(manifest.peerDependencies?.["drizzle-orm"]).toBeDefined();
        expect(manifest.peerDependenciesMeta?.["drizzle-orm"]?.optional).toBe(
          true
        );
      }
    }
  );
});
