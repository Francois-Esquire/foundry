import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PackageInternals } from "../../src/lib/internal-analysis-types";
import type {
  LensId,
  LensReader,
  LensSettings,
} from "../../src/lib/lenses/lens-types";
import {
  LENS_SCHEMA_VERSIONS,
  lensEntries,
} from "../../src/lib/lenses/lens-types";
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
    primitives: {},
    responsibilities: { package: { id: "@s/a" } },
    review: {},
    rewiring: {},
    topology: { modules: [], package: { id: "@s/a", root: "packages/a" } },
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
