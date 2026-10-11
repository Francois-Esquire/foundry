import { describe, expect, it } from "vitest";
import {
  importPairs,
  importTrafficLens,
} from "../../src/lib/lenses/import-traffic";
import type { LensReader } from "../../src/lib/lenses/lens-types";

const packageOf = new Map([
  ["ui/a.ts", "ui"],
  ["ui/b.ts", "ui"],
  ["core/x.ts", "core"],
  ["core/y.ts", "core"],
]);

describe("the import-traffic lens", () => {
  it("joins each ordered package pair to the files at both ends of its edges, once, sorted", () => {
    expect(
      importPairs(
        [
          { source: "ui/b.ts", target: "core/x.ts" },
          { source: "ui/a.ts", target: "core/y.ts" },
          { source: "ui/a.ts", target: "core/x.ts" },
          // Within one package, and to a file in no package: left out.
          { source: "ui/a.ts", target: "ui/b.ts" },
          { source: "ui/a.ts", target: "elsewhere.ts" },
          { source: "core/x.ts", target: "ui/a.ts" },
        ],
        packageOf
      )
    ).toEqual([
      {
        consumerFiles: ["core/x.ts"],
        from: "core",
        supplierFiles: ["ui/a.ts"],
        to: "ui",
      },
      {
        consumerFiles: ["ui/a.ts", "ui/b.ts"],
        from: "ui",
        supplierFiles: ["core/x.ts", "core/y.ts"],
        to: "core",
      },
    ]);
  });

  it("sorts pairs and files by code unit, not by locale", () => {
    const pairs = importPairs(
      [
        { source: "b/Z.ts", target: "a/b.ts" },
        { source: "b/a.ts", target: "a/B.ts" },
      ],
      new Map([
        ["b/Z.ts", "b"],
        ["b/a.ts", "b"],
        ["a/b.ts", "a"],
        ["a/B.ts", "a"],
      ])
    );
    expect(pairs).toEqual([
      {
        consumerFiles: ["b/Z.ts", "b/a.ts"],
        from: "b",
        supplierFiles: ["a/B.ts", "a/b.ts"],
        to: "a",
      },
    ]);
  });

  it("derives no pair from no crossing edge", () => {
    expect(
      importTrafficLens.derive(
        {
          edges: [{ source: "ui/a.ts", target: "ui/b.ts" }],
          modules: [
            { id: "ui/a.ts", package: "ui" },
            { id: "ui/b.ts", package: "ui" },
          ],
        },
        {}
      )
    ).toEqual({ pairs: [] });
  });

  it("reads the module index for each file's package and every edge shard, nothing else", async () => {
    const reader = {
      moduleEdgeShards: () =>
        Promise.resolve([
          {
            edges: [
              {
                id: "ui/a.ts→core/x.ts",
                relation: "dependency",
                scope: "cross-package",
                source: "ui/a.ts",
                target: "core/x.ts",
                typeOnly: false,
              },
            ],
            package: "ui",
          },
          { edges: [], package: "core" },
        ]),
      moduleIndex: () =>
        Promise.resolve({
          modules: [
            {
              fanIn: 0,
              fanOut: 1,
              fileKind: "source",
              id: "ui/a.ts",
              package: "ui",
              path: "ui/a.ts",
              shard: "modules/ui.json",
            },
            {
              fileKind: "source",
              id: "core/x.ts",
              package: "core",
              path: "core/x.ts",
              shard: "modules/core.json",
            },
          ],
        }),
    } as unknown as LensReader;
    const source = await importTrafficLens.read(reader, {});
    expect(source).toEqual({
      edges: [{ source: "ui/a.ts", target: "core/x.ts" }],
      modules: [
        { id: "ui/a.ts", package: "ui" },
        { id: "core/x.ts", package: "core" },
      ],
    });
    expect(importTrafficLens.derive(source, {})).toEqual({
      pairs: [
        {
          consumerFiles: ["ui/a.ts"],
          from: "ui",
          supplierFiles: ["core/x.ts"],
          to: "core",
        },
      ],
    });
  });
});
