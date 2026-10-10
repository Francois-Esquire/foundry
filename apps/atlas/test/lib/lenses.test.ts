import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PackageInternals } from "../../src/lib/internal-analysis-types";
import type { FileRolesSource } from "../../src/lib/lenses/file-roles";
import { fileRolesLens } from "../../src/lib/lenses/file-roles";
import type {
  LensId,
  LensReader,
  LensSettings,
} from "../../src/lib/lenses/lens-types";
import {
  LENS_SCHEMA_VERSIONS,
  lensEntries,
} from "../../src/lib/lenses/lens-types";
import { rootRelative } from "../../src/lib/lenses/package-internals";
import { packageSizesLens } from "../../src/lib/lenses/package-sizes";
import type { AnyLens } from "../../src/lib/lenses/run";
import { LENSES, writeLenses } from "../../src/lib/lenses/run";
import {
  lensStage,
  SEMANTIC_STAGE_VERSIONS,
  stageClosure,
} from "../../src/lib/semantics-stages";
import type { DatasetManifest } from "../../src/lib/semantics-types";

const NO_FILES = { config: 0, other: 0, source: 0, story: 0, test: 0 };

describe("the package-sizes lens", () => {
  it("joins each graph node to its file count by kind, sorted by id", () => {
    const sizes = packageSizesLens.derive(
      {
        modules: [
          { fileKind: "source", package: "@s/b" },
          { fileKind: "test", package: "@s/b" },
          { fileKind: "source", package: "@s/b" },
          { package: "@s/a" },
        ],
        nodes: [
          { analyzed: true, id: "@s/b", layer: 0 },
          { analyzed: false, id: "@s/a", layer: null },
          { analyzed: true, id: "@s/c", layer: 1 },
        ],
      },
      {}
    );
    expect(sizes).toEqual({
      packages: [
        {
          analyzed: false,
          id: "@s/a",
          layer: null,
          modules: { byKind: { ...NO_FILES, unknown: 1 }, total: 1 },
        },
        {
          analyzed: true,
          id: "@s/b",
          layer: 0,
          modules: {
            byKind: { ...NO_FILES, source: 2, test: 1, unknown: 0 },
            total: 3,
          },
        },
        {
          analyzed: true,
          id: "@s/c",
          layer: 1,
          modules: { byKind: { ...NO_FILES, unknown: 0 }, total: 0 },
        },
      ],
    });
  });
});

/** One module's role evidence, as the primitive conventions save it. */
function evidence(
  module: string,
  {
    crossResponsibility = 0,
    localGroups = 1,
    packageWide = 0,
    scopes = "single-scope" as "single-scope" | "mixed-scope" | "none",
    symbols = 1,
    unresolvedSymbols = 0,
  } = {}
) {
  return {
    composition: { scopes },
    fragmentation: { crossResponsibility, localGroups, packageWide },
    module,
    symbols,
    unresolvedSymbols,
  };
}

type SourcePackage = FileRolesSource["packages"][number];

/** A package of `modules`, each with fan-in 0, unless the overrides say otherwise. */
function rolesPackage(
  id: string,
  root: string,
  modules: string[],
  overrides: Partial<Omit<SourcePackage, "id" | "root">> = {}
): SourcePackage {
  return {
    id,
    primitives: { modules: [] },
    rewiring: { composition: [] },
    root,
    topology: {
      modules: modules.map((module) => ({ fanIn: 0, id: module })),
      roles: [],
      summary: { highFanCutoff: { fanIn: 0 } },
    },
    ...overrides,
  };
}

describe("rootRelative", () => {
  it("joins a module id to its package root, adding nothing for a package at the workspace root", () => {
    expect(rootRelative("packages/r", "src/a.ts")).toBe("packages/r/src/a.ts");
    expect(rootRelative(".", "src/a.ts")).toBe("src/a.ts");
    expect(rootRelative("", "src/a.ts")).toBe("src/a.ts");
  });
});

describe("the file-roles lens", () => {
  it("gives each module the first role that holds: junction, mixed, commons, unknown", () => {
    const roles = fileRolesLens.derive(
      {
        missing: [],
        packages: [
          rolesPackage(
            "@s/a",
            "packages/a",
            [
              "root.ts",
              "mixed.ts",
              "commons.ts",
              "unknown.ts",
              "empty.ts",
              "plain.ts",
            ],
            {
              primitives: {
                modules: [
                  evidence("root.ts", { scopes: "mixed-scope" }),
                  evidence("mixed.ts", {
                    crossResponsibility: 2,
                    localGroups: 0,
                    scopes: "mixed-scope",
                  }),
                  evidence("commons.ts", {
                    localGroups: 0,
                    packageWide: 1,
                    symbols: 3,
                    unresolvedSymbols: 3,
                  }),
                  evidence("unknown.ts", { symbols: 2, unresolvedSymbols: 2 }),
                  evidence("empty.ts", { symbols: 0, unresolvedSymbols: 0 }),
                  evidence("elsewhere.ts", { scopes: "mixed-scope" }),
                ],
              },
              rewiring: {
                composition: [
                  { compositionRoot: true, module: "root.ts" },
                  { compositionRoot: false, module: "plain.ts" },
                ],
              },
            }
          ),
        ],
      },
      {}
    );
    const [pkg] = roles.packages;
    expect(
      pkg?.modules.map((module) => [module.module, module.role ?? null])
    ).toEqual([
      ["packages/a/commons.ts", "commons"],
      ["packages/a/empty.ts", null],
      ["packages/a/mixed.ts", "mixed"],
      ["packages/a/plain.ts", null],
      ["packages/a/root.ts", "junction"],
      ["packages/a/unknown.ts", "unknown"],
    ]);
    expect(pkg?.modules.find((m) => m.role === undefined)).not.toHaveProperty(
      "role"
    );
  });

  it("copies the topology's high fan-in role, fan-in, and cutoff without measuring again", () => {
    const roles = fileRolesLens.derive(
      {
        missing: ["@s/z"],
        packages: [
          rolesPackage("@s/b", ".", ["src/b.ts", "src/a.ts"], {
            topology: {
              modules: [
                { fanIn: 2, id: "src/b.ts" },
                { fanIn: 9, id: "src/a.ts" },
              ],
              roles: [
                { module: "src/a.ts", roles: ["high-fan-in", "bridge"] },
                { module: "src/b.ts", roles: ["dependency-sink"] },
              ],
              summary: { highFanCutoff: { fanIn: 4 } },
            },
          }),
          rolesPackage("@s/a", "packages/a", ["src/c.ts"]),
        ],
      },
      {}
    );
    expect(roles).toEqual({
      missing: ["@s/z"],
      packages: [
        {
          highFanInCutoff: 0,
          id: "@s/a",
          modules: [
            { fanIn: 0, highFanIn: false, module: "packages/a/src/c.ts" },
          ],
        },
        {
          highFanInCutoff: 4,
          id: "@s/b",
          modules: [
            { fanIn: 9, highFanIn: true, module: "src/a.ts" },
            { fanIn: 2, highFanIn: false, module: "src/b.ts" },
          ],
        },
      ],
    });
  });

  it("names no module high fan-in in a package whose saved cutoff is 0", () => {
    const roles = fileRolesLens.derive(
      {
        missing: [],
        packages: [
          rolesPackage("@s/a", "packages/a", ["a.ts", "b.ts"], {
            topology: {
              modules: [
                { fanIn: 0, id: "a.ts" },
                { fanIn: 0, id: "b.ts" },
              ],
              roles: [
                { module: "a.ts", roles: ["isolated"] },
                { module: "b.ts", roles: ["isolated"] },
              ],
              summary: { highFanCutoff: { fanIn: 0 } },
            },
          }),
        ],
      },
      {}
    );
    expect(roles.packages[0]?.highFanInCutoff).toBe(0);
    expect(roles.packages[0]?.modules.some((m) => m.highFanIn)).toBe(false);
  });
});

describe("the registry", () => {
  it("registers every lens once, at the schema version the reader and its stage hold", () => {
    const ids = LENSES.map((lens) => lens.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(LENS_SCHEMA_VERSIONS).sort());
    for (const lens of LENSES) {
      expect(LENS_SCHEMA_VERSIONS[lens.id]).toBe(lens.schemaVersion);
      expect(SEMANTIC_STAGE_VERSIONS[lensStage(lens.id)].schemaVersion).toBe(
        lens.schemaVersion
      );
    }
  });

  it("orders each lens after the lenses it consumes, which its stage depends on", () => {
    const earlier: LensId[] = [];
    for (const lens of LENSES) {
      const closure = stageClosure(lensStage(lens.id));
      expect(closure).toContain("materialization");
      for (const consumed of lens.consumes ?? []) {
        expect(earlier).toContain(consumed);
        expect(closure).toContain(lensStage(consumed));
      }
      earlier.push(lens.id);
    }
  });

  it("names each lens's file and schema version for the manifest", () => {
    expect(lensEntries()).toEqual({
      "file-roles": { file: "lenses/file-roles.json", schemaVersion: 1 },
      "package-sizes": { file: "lenses/package-sizes.json", schemaVersion: 1 },
    });
  });
});

describe("writeLenses", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  const internals = {
    locality: { package: { id: "@s/a" } },
    primitives: {
      modules: [
        {
          composition: { scopes: "mixed-scope" },
          fragmentation: {
            crossResponsibility: 0,
            localGroups: 2,
            packageWide: 0,
          },
          module: "src/a.ts",
          symbols: 2,
          unresolvedSymbols: 0,
        },
      ],
    },
    responsibilities: { package: { id: "@s/a" } },
    review: {},
    rewiring: { composition: [] },
    topology: {
      modules: [{ fanIn: 0, id: "src/a.ts" }],
      package: { id: "@s/a", root: "packages/a" },
      roles: [],
      summary: { highFanCutoff: { fanIn: 0 } },
    },
  };

  /** An unpublished tree, and the draft manifest that names its files. */
  function unpublished(): DatasetManifest {
    dir = mkdtempSync(join(tmpdir(), "atlas-lenses-"));
    const files: Record<string, unknown> = {
      "internals/@s__a.json": internals,
      "modules/index.json": {
        modules: [{ fileKind: "source", package: "@s/a" }],
      },
      "projections/dependency-graph.json": {
        edges: [],
        nodes: [{ analyzed: true, id: "@s/a", label: "a", layer: 0 }],
      },
    };
    for (const [file, value] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify(value));
    }
    return {
      files: {
        moduleIndex: "modules/index.json",
        projections: { dependencyGraph: "projections/dependency-graph.json" },
      },
      lenses: lensEntries(),
      packages: [
        {
          id: "@s/a",
          internals: "internals/@s__a.json",
          path: "packages/a",
          status: "complete",
        },
        { id: "@s/b", path: "packages/b", status: "failed" },
        { id: "@s/c", path: "packages/c", status: "complete" },
      ],
      schemaVersion: 4,
    } as unknown as DatasetManifest;
  }

  /** Runs `lenses` over a fresh tree, writing into it, and returns what each wrote. */
  async function run(
    lenses: readonly AnyLens[] | undefined,
    settings: LensSettings = { domains: [] }
  ): Promise<[string, unknown][]> {
    const draft = unpublished();
    const written: [string, unknown][] = [];
    await writeLenses({
      dir,
      draft,
      ...(lenses !== undefined && { lenses }),
      settings,
      write: (file, value) => {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), JSON.stringify(value));
        written.push([file, value]);
      },
    });
    return written;
  }

  interface Probe<Source> {
    consumes?: readonly LensId[];
    derive?: (source: Source, settings: Partial<LensSettings>) => unknown;
    settings?: readonly (keyof LensSettings)[];
  }

  /** A lens over `read`, under the registered id, as a test needs one. */
  function probe<Source>(
    read: (reader: LensReader) => Promise<Source>,
    { derive = (source) => source, ...rest }: Probe<Source> = {}
  ): AnyLens {
    // A probe writes whatever the test reads, which no lens output type names.
    return {
      derive,
      id: "package-sizes",
      read,
      schemaVersion: 1,
      settings: [],
      ...rest,
    } as unknown as AnyLens;
  }

  it("reads the unpublished tree through the draft manifest and writes each lens's file", async () => {
    expect(await run(undefined)).toEqual([
      [
        "lenses/file-roles.json",
        {
          missing: ["@s/c"],
          packages: [
            {
              highFanInCutoff: 0,
              id: "@s/a",
              modules: [
                {
                  fanIn: 0,
                  highFanIn: false,
                  module: "packages/a/src/a.ts",
                  role: "mixed",
                },
              ],
            },
          ],
        },
      ],
      [
        "lenses/package-sizes.json",
        {
          packages: [
            {
              analyzed: true,
              id: "@s/a",
              layer: 0,
              modules: {
                byKind: { ...NO_FILES, source: 1, unknown: 0 },
                total: 1,
              },
            },
          ],
        },
      ],
    ]);
  });

  it("lists the draft's packages by their deterministic fields", async () => {
    const written = await run([probe(async (reader) => reader.packages())]);
    expect(written[0]?.[1]).toEqual([
      { id: "@s/a", internals: true, status: "complete" },
      { id: "@s/b", internals: false, status: "failed" },
      { id: "@s/c", internals: false, status: "complete" },
    ]);
  });

  it("parses each file once for every lens in the phase", async () => {
    const read: PackageInternals[] = [];
    const twice = probe(async (reader) => {
      read.push(await reader.internals("@s/a"));
      return null;
    });
    await run([twice, twice]);
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual(internals);
    expect(read[1]?.topology).toBe(read[0]?.topology);
  });

  it("lets a lens read the output of a lens it consumes, once that lens has run", async () => {
    const first = probe(async () => ({ seen: "first" }));
    const second = probe(async (reader) => reader.lens("package-sizes"), {
      consumes: ["package-sizes"],
    });
    const written = await run([first, second]);
    expect(written.map(([, value]) => value)).toEqual([
      { seen: "first" },
      { seen: "first" },
    ]);
  });

  it("refuses a lens that reads a lens it does not consume", async () => {
    const first = probe(async () => ({ seen: "first" }));
    const second = probe(async (reader) => reader.lens("package-sizes"));
    await expect(run([first, second])).rejects.toThrow(
      "The package-sizes lens reads the package-sizes lens without naming it in consumes, or before the package-sizes lens runs."
    );
  });

  it("refuses a lens that reads a lens it consumes before that lens runs", async () => {
    const early = probe(async (reader) => reader.lens("package-sizes"), {
      consumes: ["package-sizes"],
    });
    await expect(run([early])).rejects.toThrow(
      "The package-sizes lens reads the package-sizes lens without naming it in consumes, or before the package-sizes lens runs."
    );
  });

  it("hands a lens only the settings it names", async () => {
    const domains = [{ facets: ["packages/a"], name: "core" }];
    const named = probe(async () => null, {
      derive: (_source, settings) => settings,
      settings: ["domains"],
    });
    const unnamed = probe(async () => null, {
      derive: (_source, settings) => settings,
    });
    const written = await run([named, unnamed], { domains });
    expect(written.map(([, value]) => value)).toEqual([{ domains }, {}]);
  });

  it("fails when a lens throws", async () => {
    const broken = probe(async () => {
      throw new Error("lens broke");
    });
    await expect(run([broken])).rejects.toThrow("lens broke");
  });
});
