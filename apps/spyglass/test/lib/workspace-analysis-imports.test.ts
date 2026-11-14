import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { type BunPlugin, build as bundle } from "bun";
import { build as viteBuild } from "vite";
import { describe, expect, test } from "vitest";
import { noNodeBuiltins } from "../../scripts/no-node-builtins";

const lib = resolve(import.meta.dirname, "../../src/lib");
const ENTRY = resolve(lib, "browser-analysis.ts");

const NATIVE_MODULES = new Set(
  [
    "boundary",
    "dataset-files",
    "dependencies",
    "dependency-graph",
    "dependency-inventory",
    "directory-publication",
    "fold-plan",
    "git-history",
    "ignore",
    "internal-analysis",
    "package-local",
    "path-native",
    "project",
    "semantics",
    "semantics-cache",
    "semantics-discover",
    "semantics-fingerprint",
    "worker-runtime",
    "workspace-derive",
  ].map((name) => resolve(lib, name))
);
const FORBIDDEN_PACKAGES = new Set(["dependency-cruiser", "typescript"]);
const EXTERNAL = new Set(["#file-map-cruise-engine", "ts-morph"]);
const TS_EXTENSION = /\.tsx?$/;
const ANY_IMPORT = /.*/;

const importGuard: BunPlugin = {
  name: "browser-analysis-import-guard",
  setup(build) {
    build.onResolve({ filter: ANY_IMPORT }, ({ importer, kind, path }) => {
      if (kind === "entry-point-build" || importer === "") {
        return;
      }
      const from = importer.replace(`${lib}/`, "");
      if (path.startsWith(".")) {
        const target = resolve(dirname(importer), path).replace(
          TS_EXTENSION,
          ""
        );
        if (NATIVE_MODULES.has(target)) {
          throw new Error(`Native module ${path} (${kind}) from ${from}`);
        }
        return;
      }
      if (EXTERNAL.has(path)) {
        return { external: true, path };
      }
      if (isBuiltin(path) || FORBIDDEN_PACKAGES.has(path)) {
        throw new Error(`Forbidden import ${path} (${kind}) from ${from}`);
      }
    });
  },
};

function inject(leaf: string, injected: string): BunPlugin {
  const file = resolve(lib, leaf);
  return {
    name: "inject-import",
    setup(build) {
      build.onLoad({ filter: TS_EXTENSION }, ({ path }) =>
        path === file
          ? {
              contents: `${injected}\n${readFileSync(file, "utf8")}`,
              loader: "ts",
            }
          : undefined
      );
    },
  };
}

async function walk(...plugins: BunPlugin[]) {
  const result = await bundle({
    conditions: ["spyglass-browser"],
    entrypoints: [ENTRY],
    plugins: [importGuard, ...plugins],
    target: "browser",
    throw: false,
  });
  return { logs: result.logs.map(String).join("\n"), success: result.success };
}

describe("the browser analysis import boundary", () => {
  test("reaches no native module, built-in or dependency-cruiser", async () => {
    expect(await walk()).toEqual({ logs: "", success: true });
  });

  test.each([
    [
      "module-graph.ts",
      `import { readFileSync } from "node:fs"; export const x = readFileSync;`,
      "node:fs (import-statement) from module-graph.ts",
    ],
    [
      "file-map-cruise.ts",
      `import { prepareWorkspaceInputs } from "./workspace-derive"; export const x = prepareWorkspaceInputs;`,
      "./workspace-derive (import-statement) from file-map-cruise.ts",
    ],
    [
      "workspace-analysis.ts",
      `export const x = () => import("./git-history");`,
      "./git-history (dynamic-import) from workspace-analysis.ts",
    ],
    [
      "file-map-preparation.ts",
      `import { cruise } from "dependency-cruiser"; export const x = cruise;`,
      "dependency-cruiser (import-statement) from file-map-preparation.ts",
    ],
  ])("fails when %s gains %s", async (leaf, injected, expected) => {
    const { logs, success } = await walk(inject(leaf, injected));
    expect(success).toBe(false);
    expect(logs).toContain(expected);
  });

  test("does not count type-only imports", async () => {
    const injected = `import type { Stats } from "node:fs";
import type { GitHistory } from "./git-history";
export type X = [Stats, GitHistory];`;
    expect(await walk(inject("module-graph.ts", injected))).toEqual({
      logs: "",
      success: true,
    });
  });
});

describe("the browser build's Node built-in guard", () => {
  const ENTRY_ID = "\0guard-entry";
  const buildOf = (source: string) =>
    viteBuild({
      build: { rolldownOptions: { input: "guard-entry" }, write: false },
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          load: (id) => (id === ENTRY_ID ? source : null),
          name: "guard-entry",
          resolveId: (id) => (id === "guard-entry" ? ENTRY_ID : null),
        },
        noNodeBuiltins(),
      ],
      root: resolve(import.meta.dirname, "../.."),
    });

  test.each([
    `import { readFileSync } from "node:fs"; console.log(readFileSync);`,
    `import { readFileSync } from "fs"; console.log(readFileSync);`,
  ])("fails a build that imports a built-in: %s", async (source) => {
    await expect(buildOf(source)).rejects.toThrow("a Node built-in");
  });

  test("allows a bare name that resolves to a browser package", async () => {
    await expect(
      buildOf(`import { Buffer } from "buffer"; console.log(Buffer);`)
    ).resolves.toBeDefined();
  });
});
