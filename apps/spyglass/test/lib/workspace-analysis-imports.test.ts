import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BunPlugin, build as bundle } from "bun";
import { describe, expect, test } from "vitest";

// The portable computation's runtime import graph, traversed by Bun's
// bundler from `workspace-analysis.ts` (the prepared workspace computation)
// and the file-map entries below. Every project-owned module reached at run
// time is checked, side-effect and dynamic imports included. The bundler
// elides type-only imports, so they do not count. The build sets the
// `spyglass-browser` condition, under which `#path` resolves to
// `path-posix.ts`. Five outcomes per import:
//
// - A project module that acquires native input (file system, cruise, Git,
//   program creation or capture, ownership walks, fold reads, native path)
//   fails the bundle.
// - A portable dependency (POSIX path operations, synchronous SHA-256) is
//   bundled and recorded.
// - A named external blocker is left external and recorded: ts-morph, which
//   bundles the TypeScript compiler and its host.
// - The cruise is left external and recorded, from its one importer only:
//   `#file-map-cruise-engine` from `file-map-cruise.ts`, the prebuilt
//   isolated engine (dist/engine), which carries dependency-cruiser over a
//   private in-memory `node:fs`. Neither dependency-cruiser nor `node:fs`
//   is reachable from the computation itself.
// - Any other package or builtin (node:fs, node:path, node:crypto,
//   node:child_process, dependency-cruiser, yaml, ignore, ...) fails.

const lib = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/lib");
const entrypoints = [resolve(lib, "workspace-analysis.ts")];
/** The internal file-map proof entry: preparation from a recorded file map, then analysis. */
const fileMapEntrypoints = [resolve(lib, "file-map-analysis.ts")];
/** The internal in-memory dataset: the scan's artifact assembly over an owned collection. */
const assemblyEntrypoints = [resolve(lib, "in-memory-dataset.ts")];
/**
 * The internal file-map dataset: file-map analysis, discovery and inventory,
 * then the assembly; its scanner; and the public GitHub loader and the
 * repository scan composed from them.
 */
const fileMapDatasetEntrypoints = [
  resolve(lib, "file-map-dataset.ts"),
  resolve(lib, "file-map-scanner.ts"),
  resolve(lib, "github-loader.ts"),
  resolve(lib, "github-request.ts"),
  resolve(lib, "repository-scan.ts"),
];

/** Project modules that acquire native input; the computation must not reach them. */
const NATIVE_MODULES = [
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
].map((name) => resolve(lib, name));

/** Packages the portable computation may bundle. */
const PORTABLE_DEPENDENCIES = new Set([
  "#path",
  "@noble/hashes/sha2.js",
  "@noble/hashes/utils.js",
  "path-browserify",
]);

/**
 * File-map preparation also parses `pnpm-workspace.yaml` as data and answers
 * gitignore rules from the map, so it may bundle these two pure packages.
 */
const FILE_MAP_DEPENDENCIES = new Set([
  ...PORTABLE_DEPENDENCIES,
  "ignore",
  "yaml",
]);

/**
 * Dataset assembly also validates saved shapes with zod, draws island
 * contours with d3-contour and orders keys with `@foundry/lib/ordering`;
 * all three are pure and bundle into a browser build.
 */
const ASSEMBLY_DEPENDENCIES = new Set([
  ...PORTABLE_DEPENDENCIES,
  "@foundry/lib/ordering",
  "d3-contour",
  "zod",
]);

/**
 * The file-map dataset bundles both sets: preparation's and the assembly's.
 * The repository loader adds synchronous SHA-1 for Git blob ids, and
 * Octokit's fetch-based request client with what it imports.
 */
const OCTOKIT = [
  "@octokit/endpoint",
  "@octokit/request",
  "@octokit/request-error",
  "content-type",
  "json-with-bigint",
  "universal-user-agent",
];
const FILE_MAP_DATASET_DEPENDENCIES = new Set([
  ...FILE_MAP_DEPENDENCIES,
  ...ASSEMBLY_DEPENDENCIES,
  "@noble/hashes/legacy.js",
  ...OCTOKIT,
]);

/** External imports that remain, each a stated blocker rather than a pass. */
const EXTERNAL_BLOCKERS = new Set(["ts-morph"]);

/** The file-map cruise's one import, allowed from its one importer. */
const CRUISE_IMPORTS: ReadonlyMap<string, string> = new Map([
  ["#file-map-cruise-engine", "file-map-cruise.ts"],
]);

const TS_EXTENSION = /\.tsx?$/;
const ANY_IMPORT = /.*/;

interface GuardRecord {
  /** Each external blocker and the project modules importing it. */
  externals: Map<string, Set<string>>;
  /** Each portable dependency and the modules importing it. */
  portable: Map<string, Set<string>>;
}

function note(map: Map<string, Set<string>>, key: string, from: string): void {
  const importers = map.get(key) ?? new Set<string>();
  importers.add(from);
  map.set(key, importers);
}

function importGuard(
  record: GuardRecord,
  portable: ReadonlySet<string> = PORTABLE_DEPENDENCIES,
  cruise: ReadonlyMap<string, string> = new Map()
): BunPlugin {
  return {
    name: "workspace-analysis-import-guard",
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
          if (NATIVE_MODULES.includes(target)) {
            throw new Error(
              `Native module in prepared computation: ${path} (${kind}) from ${from}`
            );
          }
          return;
        }
        if (portable.has(path)) {
          note(record.portable, path, from);
          return;
        }
        if (cruise.get(path) === from) {
          note(record.externals, path, from);
          return { external: true, path };
        }
        if (!EXTERNAL_BLOCKERS.has(path)) {
          throw new Error(
            `Unsupported runtime import in prepared computation: ${path} (${kind}) from ${from}`
          );
        }
        note(record.externals, path, from);
        return { external: true, path };
      });
    },
  };
}

/** Prepend `injected` to the module whose path ends with `leaf`. */
function inject(leaf: string, injected: string): BunPlugin {
  const file = resolve(lib, leaf);
  return {
    name: "inject-import",
    setup(build) {
      build.onLoad(
        { filter: new RegExp(`${leaf.replace(".", "\\.")}$`) },
        ({ path }) =>
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

async function bundleAnalysis(...plugins: BunPlugin[]) {
  return await bundleEntries(entrypoints, PORTABLE_DEPENDENCIES, plugins);
}

async function bundleEntries(
  entries: string[],
  portable: ReadonlySet<string>,
  plugins: BunPlugin[],
  cruise?: ReadonlyMap<string, string>
) {
  const record: GuardRecord = { externals: new Map(), portable: new Map() };
  const result = await bundle({
    conditions: ["spyglass-browser"],
    entrypoints: entries,
    plugins: [importGuard(record, portable, cruise), ...plugins],
    target: "browser",
    throw: false,
  });
  return { logs: result.logs.map(String).join("\n"), record, result };
}

describe("prepared workspace computation import boundary", () => {
  test("reaches no native module and only ts-morph as an external blocker", async () => {
    const { logs, record, result } = await bundleAnalysis();
    expect(logs).toBe("");
    expect(result.success).toBe(true);
    expect([...record.externals.keys()]).toEqual(["ts-morph"]);
    expect([...(record.externals.get("ts-morph") ?? [])].sort()).toEqual([
      "concept-overlap.ts",
      "concept-ownership.ts",
      "concepts.ts",
      "local-complexity.ts",
      "reference-index.ts",
      "references.ts",
      "symbols.ts",
      "usage.ts",
      "workspace-analysis.ts",
    ]);
    // Path operations come from `#path`, which the browser condition
    // resolves to path-posix.ts; plan fingerprints are the only hashing.
    expect(
      Object.fromEntries(
        [...record.portable].map(([name, importers]) => [
          name,
          [...importers].sort(),
        ])
      )
    ).toEqual({
      "@noble/hashes/sha2.js": ["sha256.ts"],
      "@noble/hashes/utils.js": ["sha256.ts"],
      "#path": [
        "boundary-model.ts",
        "concept-overlap.ts",
        "concept-ownership.ts",
        "concepts.ts",
        "fold-planning.ts",
        "history-commits.ts",
        "local-complexity.ts",
        "module-graph.ts",
        "outgoing-imports.ts",
        "plan.ts",
        "references.ts",
        "symbols.ts",
      ],
      "path-browserify": ["path-posix.ts"],
    });
  });

  test("rejects native program creation and the native path target", async () => {
    for (const [leaf, injected, expected] of [
      [
        "workspace-analysis.ts",
        `import { createProject } from "./project"; export const create = createProject;`,
        "./project (import-statement) from workspace-analysis.ts",
      ],
      [
        "reachability.ts",
        `import { join } from "./path-native"; export const joined = join;`,
        "./path-native (import-statement) from reachability.ts",
      ],
    ] as const) {
      const { logs, result } = await bundleAnalysis(inject(leaf, injected));
      expect(result.success).toBe(false);
      expect(logs).toContain(expected);
    }
  });

  // Injected two or more imports below the entry: reachability.ts is
  // reached only through change-coupling.ts.
  test.each([
    {
      expected: "node:fs (import-statement)",
      injected: `import { readFileSync } from "node:fs"; export const read = readFileSync;`,
      label: "a value import of node:fs",
    },
    {
      expected: "node:path (import-statement)",
      injected: `import { join } from "node:path"; export const joined = join;`,
      label: "a direct node:path import",
    },
    {
      expected: "node:crypto (import-statement)",
      injected: `import { createHash } from "node:crypto"; export const hash = createHash;`,
      label: "a node:crypto import",
    },
    {
      expected: "node:child_process (import-statement)",
      injected: `import "node:child_process";`,
      label: "a side-effect import of node:child_process",
    },
    {
      expected: "dependency-cruiser (import-statement)",
      injected: `import { cruise } from "dependency-cruiser"; export const run = cruise;`,
      label: "a dependency-cruiser import",
    },
    {
      expected: "./git-history (dynamic-import)",
      injected: `export const history = () => import("./git-history");`,
      label: "a dynamic import of the Git adapter",
    },
    {
      expected: "./ignore (import-statement)",
      injected: `import "./ignore";`,
      label: "a side-effect import of the ignore reader",
    },
    {
      expected: "./boundary (import-statement)",
      injected: `import { ownerBoundary } from "./boundary"; export const own = ownerBoundary;`,
      label: "the native owner default",
    },
    {
      expected: "./fold-plan (import-statement)",
      injected: `import { readFoldInputs } from "./fold-plan"; export const read = readFoldInputs;`,
      label: "the native fold reader",
    },
    {
      expected: "./workspace-derive (import-statement)",
      injected: `import { prepareWorkspaceDerivation } from "./workspace-derive"; export const prepare = prepareWorkspaceDerivation;`,
      label: "native workspace preparation",
    },
  ])("rejects $label added transitively", async ({ expected, injected }) => {
    const { logs, result } = await bundleAnalysis(
      inject("reachability.ts", injected)
    );
    expect(result.success).toBe(false);
    expect(logs).toContain(`${expected} from reachability.ts`);
  });

  test.each([
    {
      injected: `import type { Stats } from "node:fs"; export type FileStats = Stats;`,
      label: "an import type declaration",
    },
    {
      injected: `import { type Stats } from "node:fs"; export type FileStats = Stats;`,
      label: "an inline type specifier",
    },
    {
      injected: `import type { GitHistory } from "./git-history"; export type History = GitHistory;`,
      label: "a type from a native module",
    },
  ])("does not count $label", async ({ injected }) => {
    const { logs, result } = await bundleAnalysis(
      inject("reachability.ts", injected)
    );
    expect(logs).toBe("");
    expect(result.success).toBe(true);
  });
});

describe("file-map preparation and analysis import boundary", () => {
  const bundleFileMap = (...plugins: BunPlugin[]) =>
    bundleEntries(
      fileMapEntrypoints,
      FILE_MAP_DEPENDENCIES,
      plugins,
      CRUISE_IMPORTS
    );

  test("reaches no native module; ts-morph and the cruise's imports are the only externals", async () => {
    const { logs, record, result } = await bundleFileMap();
    expect(logs).toBe("");
    expect(result.success).toBe(true);
    expect(
      Object.fromEntries(
        [...record.externals]
          .filter(([name]) => name !== "ts-morph")
          .map(([name, importers]) => [name, [...importers]])
      )
    ).toEqual({
      "#file-map-cruise-engine": ["file-map-cruise.ts"],
    });
    expect([...(record.externals.get("ts-morph") ?? [])].sort()).toEqual([
      "concept-overlap.ts",
      "concept-ownership.ts",
      "concepts.ts",
      "file-map-preparation.ts",
      "fold-inputs.ts",
      "local-complexity.ts",
      "module-roles.ts",
      "package-local-analysis.ts",
      "reference-index.ts",
      "references.ts",
      "source-files.ts",
      "symbols.ts",
      "usage.ts",
      "workspace-analysis.ts",
    ]);
    expect(
      Object.fromEntries(
        [...record.portable].map(([name, importers]) => [
          name,
          [...importers].sort(),
        ])
      )
    ).toEqual({
      "@noble/hashes/sha2.js": ["sha256.ts"],
      "@noble/hashes/utils.js": ["sha256.ts"],
      "#path": [
        "boundary-manifest.ts",
        "boundary-model.ts",
        "concept-overlap.ts",
        "concept-ownership.ts",
        "concepts.ts",
        "dependency-rules.ts",
        "discovery-rules.ts",
        "file-map-preparation.ts",
        "fold-inputs.ts",
        "fold-planning.ts",
        "history-commits.ts",
        "ignore-rules.ts",
        "local-complexity.ts",
        "module-graph.ts",
        "module-roles.ts",
        "outgoing-imports.ts",
        "package-local-analysis.ts",
        "plan.ts",
        "references.ts",
        "scope.ts",
        "symbols.ts",
      ],
      ignore: ["ignore-rules.ts"],
      "path-browserify": ["path-posix.ts"],
      yaml: ["boundary-manifest.ts"],
    });
  });

  // Each native preparer injected into the file-map preparation itself or a
  // shared rule module it reaches must fail and name its importer.
  test.each([
    ["file-map-preparation.ts", "./boundary", "resolveBoundary"],
    ["file-map-preparation.ts", "./package-local", "preparePackageLocalSource"],
    ["file-map-preparation.ts", "./project", "createProject"],
    ["file-map-preparation.ts", "./dependencies", "cruiseWorkspace"],
    ["file-map-preparation.ts", "./git-history", "collectGitHistory"],
    ["boundary-manifest.ts", "./ignore", "createIgnorer"],
    ["fold-inputs.ts", "./fold-plan", "readFoldInputs"],
    ["file-map-cruise.ts", "./dependencies", "cruiseWorkspace"],
    ["file-map-cruise.ts", "./workspace-derive", "prepareWorkspaceDerivation"],
  ])("rejects %s importing %s", async (leaf, module, name) => {
    const { logs, result } = await bundleFileMap(
      inject(
        leaf,
        `import { ${name} as injectedNative } from "${module}"; export const injected = injectedNative;`
      )
    );
    expect(result.success).toBe(false);
    expect(logs).toContain(`${module} (import-statement) from ${leaf}`);
  });

  test.each([
    ["file-map-preparation.ts", "node:fs", "readFileSync"],
    ["file-map-preparation.ts", "dependency-cruiser", "cruise"],
    ["file-map-cruise.ts", "dependency-cruiser", "cruise"],
    ["file-map-cruise.ts", "node:fs", "readFileSync"],
    ["file-map-cruise.ts", "node:child_process", "spawn"],
  ])(
    "rejects %s importing %s outside the cruise's allowance",
    async (leaf, module, name) => {
      const { logs, result } = await bundleFileMap(
        inject(
          leaf,
          `import { ${name} as injectedNative } from "${module}"; export const injected = injectedNative;`
        )
      );
      expect(result.success).toBe(false);
      expect(logs).toContain(`${module} (import-statement) from ${leaf}`);
    }
  );

  test("rejects a builtin in a shared rule module", async () => {
    const { logs, result } = await bundleFileMap(
      inject(
        "source-files.ts",
        `import { readdirSync } from "node:fs"; export const list = readdirSync;`
      )
    );
    expect(result.success).toBe(false);
    expect(logs).toContain("node:fs (import-statement) from source-files.ts");
  });
});

describe("in-memory dataset assembly import boundary", () => {
  const bundleAssembly = (...plugins: BunPlugin[]) =>
    bundleEntries(assemblyEntrypoints, ASSEMBLY_DEPENDENCIES, plugins);

  test("reaches no native module and no external blocker", async () => {
    const { logs, record, result } = await bundleAssembly();
    expect(logs).toBe("");
    expect(result.success).toBe(true);
    expect([...record.externals.keys()]).toEqual([]);
    expect(
      Object.fromEntries(
        [...record.portable].map(([name, importers]) => [
          name,
          [...importers].sort(),
        ])
      )
    ).toEqual({
      "@foundry/lib/ordering": ["lenses/import-traffic.ts"],
      "@noble/hashes/sha2.js": ["sha256.ts"],
      "@noble/hashes/utils.js": ["sha256.ts"],
      "#path": [
        "dataset-assembly.ts",
        "dataset-manifest.ts",
        "in-memory-dataset.ts",
      ],
      "d3-contour": ["visualization/island-geometry.ts"],
      "path-browserify": ["path-posix.ts"],
      zod: [
        "dataset-analysis.ts",
        "dependency-inventory-schema.ts",
        "facet.ts",
        "rule-declaration.ts",
        "visualization/schema.ts",
      ],
    });
  });

  // The native collaborators a scan keeps outside the assembly: each one
  // injected into the assembly, the lens runner or the visualization
  // writer must fail and name its importer.
  test.each([
    ["dataset-assembly.ts", "./dataset-files", "fileTransport"],
    [
      "dataset-assembly.ts",
      "./dependency-inventory",
      "collectDependencyInventory",
    ],
    ["dataset-assembly.ts", "./dependency-graph", "resolveDependencyGraph"],
    ["dataset-assembly.ts", "./semantics-discover", "discoverSemanticsUnits"],
    [
      "dataset-assembly.ts",
      "./semantics-fingerprint",
      "collectWorkspaceInputs",
    ],
    ["dataset-assembly.ts", "./internal-analysis", "writeInternals"],
    ["dataset-assembly.ts", "./directory-publication", "replaceDirectory"],
    ["dataset-assembly.ts", "./semantics", "rootName"],
    ["lenses/run.ts", "../dataset-files", "fileTransport"],
    ["visualization/write.ts", "../dataset-files", "previousVisualization"],
  ])("rejects %s importing %s", async (leaf, module, name) => {
    const { logs, result } = await bundleAssembly(
      inject(
        leaf,
        `import { ${name} as injectedNative } from "${module}"; export const injected = injectedNative;`
      )
    );
    expect(result.success).toBe(false);
    expect(logs).toContain(`${module} (import-statement) from ${leaf}`);
  });

  test("rejects node:crypto returning to an artifact hash", async () => {
    const { logs, result } = await bundleAssembly(
      inject(
        "workspace-ingest.ts",
        `import { createHash as injectedNative } from "node:crypto"; export const injected = injectedNative;`
      )
    );
    expect(result.success).toBe(false);
    expect(logs).toContain(
      "node:crypto (import-statement) from workspace-ingest.ts"
    );
  });
});

describe("file-map dataset import boundary", () => {
  const bundleDataset = (...plugins: BunPlugin[]) =>
    bundleEntries(
      fileMapDatasetEntrypoints,
      FILE_MAP_DATASET_DEPENDENCIES,
      plugins,
      CRUISE_IMPORTS
    );

  test("reaches no native module; ts-morph and the cruise's imports are the only externals", async () => {
    const { logs, record, result } = await bundleDataset();
    expect(logs).toBe("");
    expect(result.success).toBe(true);
    expect([...record.externals.keys()].sort()).toEqual([
      "#file-map-cruise-engine",
      "ts-morph",
    ]);
    expect([...record.portable.keys()].sort()).toEqual(
      [
        "#path",
        "@foundry/lib/ordering",
        "@noble/hashes/legacy.js",
        "@noble/hashes/sha2.js",
        "@noble/hashes/utils.js",
        ...OCTOKIT,
        "d3-contour",
        "ignore",
        "path-browserify",
        "yaml",
        "zod",
      ].sort()
    );
    expect([...(record.portable.get("@octokit/request") ?? [])]).toEqual([
      "github-loader.ts",
    ]);
    expect([...(record.portable.get("#path") ?? [])]).toEqual(
      expect.arrayContaining(["dependency-rules.ts", "discovery-rules.ts"])
    );
    expect([...(record.portable.get("@noble/hashes/legacy.js") ?? [])]).toEqual(
      ["github-loader.ts"]
    );
  });

  // Native discovery, inventory and lockfile reads, and a second TypeScript
  // for the lockfile, injected into the shared rules or the composition.
  test.each([
    ["discovery-rules.ts", "./semantics-discover", "discoverSemanticsUnits"],
    ["discovery-rules.ts", "./ignore", "createIgnorer"],
    ["discovery-rules.ts", "./boundary", "nativeDirectoryEntries"],
    [
      "dependency-rules.ts",
      "./dependency-inventory",
      "collectDependencyInventory",
    ],
    ["dependency-rules.ts", "./dependency-graph", "resolveDependencyGraph"],
    ["file-map-dataset.ts", "./semantics", "rootName"],
    ["file-map-dataset.ts", "./dataset-files", "fileTransport"],
    ["github-loader.ts", "./dataset-files", "fileTransport"],
    ["repository-scan.ts", "./git-history", "collectGitHistory"],
    [
      "file-map-preparation.ts",
      "./semantics-discover",
      "discoverSemanticsUnits",
    ],
  ])("rejects %s importing %s", async (leaf, module, name) => {
    const { logs, result } = await bundleDataset(
      inject(
        leaf,
        `import { ${name} as injectedNative } from "${module}"; export const injected = injectedNative;`
      )
    );
    expect(result.success).toBe(false);
    expect(logs).toContain(`${module} (import-statement) from ${leaf}`);
  });

  test.each([
    ["dependency-rules.ts", "node:fs", "readFileSync"],
    ["discovery-rules.ts", "node:fs", "readdirSync"],
    ["dependency-rules.ts", "typescript", "parseConfigFileTextToJson"],
  ])("rejects %s importing the package %s", async (leaf, module, name) => {
    const { logs, result } = await bundleDataset(
      inject(
        leaf,
        `import { ${name} as injectedNative } from "${module}"; export const injected = injectedNative;`
      )
    );
    expect(result.success).toBe(false);
    expect(logs).toContain(`${module} (import-statement) from ${leaf}`);
  });
});
