import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { datasetReader } from "../../src/lib/dataset";
import { fileTransport } from "../../src/lib/dataset-files";
import type { DatasetManifest } from "../../src/lib/semantics-types";
import { readVisualizationInput } from "../../src/lib/visualization/read";
import { readPreparedVisualization } from "../../src/lib/visualization/schema";
import type { PreparedVisualization } from "../../src/lib/visualization/types";
import { writeVisualization } from "../../src/lib/visualization/write";

const prepared: PreparedVisualization = {
  foundations: [],
  groups: [],
  height: 100,
  inputKey: "test",
  islands: [
    {
      coast: [
        [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 0],
          ],
        ],
      ],
      hills: [],
      id: "a",
      radius: 10,
      shallows: [],
      x: 0,
      y: 0,
    },
  ],
  policyVersion: 5,
  schemaVersion: 1,
  settings: { foundationInfluence: 1, islandClearance: 45 },
  width: 100,
};
const manifest = {
  files: {
    moduleIndex: "modules/index.json",
    projections: { dependencyGraph: "projections/dependency-graph.json" },
    visualization: "visualization/map.json",
  },
  lenses: {
    "package-sizes": { file: "lenses/package-sizes.json", schemaVersion: 1 },
  },
  schemaVersion: 5,
} as DatasetManifest;
function files(): Record<string, unknown> {
  return {
    "lenses/package-sizes.json": {
      packages: [
        { id: "a", layer: 1, modules: { total: 2 } },
        { id: "b", layer: null, modules: { total: 1 } },
      ],
    },
    "manifest.json": manifest,
    "modules/index.json": {
      modules: [
        { id: "a/index.ts", mapPosition: { x: 4, y: -8 }, package: "a" },
        { id: "b/index.ts", mapPosition: { x: -2, y: 6 }, package: "b" },
      ],
    },
    "projections/dependency-graph.json": {
      edges: [
        {
          dependency: { moduleEdges: 3 },
          from: "a",
          kind: "dependency",
          to: "b",
        },
        { from: "a", kind: "other", to: "b" },
      ],
    },
  };
}
const reader = (values: Record<string, unknown>) =>
  datasetReader(async (path) => values[path]);

describe("prepared visualization reader", () => {
  it("supports old datasets and unknown future artifact versions", async () => {
    await expect(
      reader({
        "manifest.json": { files: {}, schemaVersion: 5 },
      }).visualization()
    ).resolves.toBeUndefined();
    for (const version of [
      { policyVersion: 1, schemaVersion: 1 },
      { policyVersion: 5, schemaVersion: 2 },
      { policyVersion: 6, schemaVersion: 1 },
    ]) {
      await expect(
        reader({
          ...files(),
          "visualization/map.json": version,
        }).visualization()
      ).resolves.toBeUndefined();
    }
    await expect(
      reader({ ...files(), "visualization/map.json": prepared }).visualization()
    ).resolves.toEqual(prepared);
  });
  it("refuses missing advertised artifacts and malformed supported artifacts", async () => {
    await expect(reader(files()).visualization()).rejects.toThrow(
      "missing visualization/map.json"
    );
    for (const value of [
      null,
      {},
      { ...prepared, width: Number.NaN },
      { ...prepared, height: Number.POSITIVE_INFINITY },
      {
        ...prepared,
        islands: [
          {
            ...prepared.islands[0],
            coast: [
              [
                [
                  [0, Number.NaN],
                  [1, 0],
                  [0, 1],
                ],
              ],
            ],
          },
        ],
      },
    ]) {
      expect(() => readPreparedVisualization(value)).toThrow(
        "prepared visualization is malformed"
      );
    }
  });
  it("rejects duplicate IDs and dangling foundation/group references", () => {
    expect(() =>
      readPreparedVisualization({
        ...prepared,
        islands: [...prepared.islands, ...prepared.islands],
      })
    ).toThrow("invalid or duplicate references");
    expect(() =>
      readPreparedVisualization({
        ...prepared,
        foundations: [
          {
            id: "zod",
            lobes: [],
            members: [
              { direct: true, distance: 1, territoryId: "missing", weight: 1 },
            ],
            name: "zod",
            prominence: 1,
            versions: [],
            x: 0,
            y: 0,
          },
        ],
      })
    ).toThrow("invalid or duplicate references");
    expect(() =>
      readPreparedVisualization({
        ...prepared,
        groups: [
          {
            dependencyIds: ["missing"],
            footprint: [],
            id: "group",
            memberIds: ["a"],
          },
        ],
      })
    ).toThrow("invalid or duplicate references");
  });
  it("requires complete, consistent shared membership across foundations and groups", async () => {
    const foundation: PreparedVisualization["foundations"][number] = {
      id: "zod",
      lobes: ["a", "b"].map((territoryId) => ({
        radius: 10,
        territoryId,
        weight: 1,
        x: 0,
        y: 0,
      })),
      members: ["a", "b"].map((territoryId) => ({
        direct: true,
        distance: 1,
        territoryId,
        weight: 1,
      })),
      name: "zod",
      prominence: 2,
      versions: ["4.0.0"],
      x: 0,
      y: 0,
    };
    const group = {
      dependencyIds: ["zod"],
      footprint: [],
      id: "ab",
      memberIds: ["b", "a"],
    };
    const shared: PreparedVisualization = {
      ...prepared,
      foundations: [foundation],
      groups: [group],
      islands: ["a", "b", "c"].map((id) => ({
        coast: [],
        hills: [],
        id,
        radius: 10,
        shallows: [],
        x: 0,
        y: 0,
      })),
    };
    expect(readPreparedVisualization(shared)).toBe(shared);
    for (const invalid of [
      { ...shared, groups: [] },
      { ...shared, groups: [{ ...group, memberIds: ["a", "c"] }] },
      { ...shared, groups: [group, { ...group, id: "duplicate" }] },
      { ...shared, groups: [{ ...group, dependencyIds: ["zod", "zod"] }] },
      { ...shared, groups: [{ ...group, dependencyIds: [] }] },
      {
        ...shared,
        foundations: [{ ...foundation, lobes: foundation.lobes.slice(0, 1) }],
      },
      { ...shared, foundations: [{ ...foundation, prominence: 3 }] },
      {
        ...shared,
        foundations: [
          {
            ...foundation,
            lobes: foundation.lobes.slice(0, 1),
            members: foundation.members.slice(0, 1),
            prominence: 1,
          },
        ],
        groups: [{ ...group, memberIds: ["a"] }],
      },
      {
        ...shared,
        foundations: [foundation, { ...foundation, id: "other" }],
        groups: [group, { ...group, dependencyIds: ["other"], id: "split" }],
      },
    ]) {
      await expect(
        reader({
          ...files(),
          "visualization/map.json": invalid,
        }).visualization()
      ).rejects.toThrow("invalid or duplicate references");
    }
  });
});

it("maps sizes, dependency weights, layers, and saved module positions", async () => {
  expect(await readVisualizationInput(reader(files()))).toEqual({
    modules: [
      { id: "a/index.ts", package: "a", x: 4, y: -8 },
      { id: "b/index.ts", package: "b", x: -2, y: 6 },
    ],
    packages: [
      { id: "a", layer: 1, size: 2 },
      { id: "b", layer: null, size: 1 },
    ],
    routes: [{ from: "a", to: "b", weight: 3 }],
  });
  await expect(
    readVisualizationInput(
      reader({
        ...files(),
        "modules/index.json": { modules: [{ id: "missing", package: "a" }] },
      })
    )
  ).rejects.toThrow("module missing has no finite saved map position");
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
function save(dir: string, path: string, value: unknown) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
}
it("prepares after lenses, preserves matching bytes, repairs prior cache, and invalidates changed content", async () => {
  const root = mkdtempSync(join(tmpdir(), "visualization-write-"));
  roots.push(root);
  const previous = join(root, "previous");
  const draft = join(root, "draft");
  for (const [path, value] of Object.entries(files())) {
    save(draft, path, value);
  }
  const run = () =>
    writeVisualization({
      dir: draft,
      draft: manifest,
      previous,
      write: (path, value) => save(draft, path, value),
    });
  await run();
  const first = await datasetReader(fileTransport(draft)).visualization();
  expect(first?.islands.map((island) => island.id)).toEqual(["a", "b"]);
  const text = readFileSync(join(draft, "visualization/map.json"), "utf8");
  save(previous, "manifest.json", manifest);
  save(previous, "visualization/map.json", first);
  await run();
  expect(readFileSync(join(draft, "visualization/map.json"), "utf8")).toBe(
    text
  );
  save(previous, "visualization/map.json", {
    islands: "broken",
    policyVersion: 5,
    schemaVersion: 1,
  });
  await run();
  expect(readFileSync(join(draft, "visualization/map.json"), "utf8")).toBe(
    text
  );
  save(previous, "visualization/map.json", {
    ...first,
    groups: [
      {
        dependencyIds: [],
        footprint: [],
        id: "invalid",
        memberIds: ["a", "b"],
      },
    ],
  });
  await run();
  expect(readFileSync(join(draft, "visualization/map.json"), "utf8")).toBe(
    text
  );
  save(draft, "lenses/package-sizes.json", {
    packages: [
      { id: "a", layer: 1, modules: { total: 20 } },
      { id: "b", layer: null, modules: { total: 1 } },
    ],
  });
  await run();
  expect(
    (await datasetReader(fileTransport(draft)).visualization())?.inputKey
  ).not.toBe(first?.inputKey);
});
