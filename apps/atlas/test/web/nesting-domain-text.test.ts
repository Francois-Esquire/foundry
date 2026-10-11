import { expect, it } from "vitest";
import type { Territory } from "../../src/web/types";
import {
  domainLabelText,
  domainsText,
  islandNestingText,
  pathRegionText,
} from "../../src/web/ui/nesting-domain-text";

const seam = (from: string, to: string, moduleEdges: number) => ({
  from,
  importSites: moduleEdges,
  moduleEdges,
  package: "@s/a",
  symbolFlow: 1,
  to,
});

const atlas = {
  domains: {
    declared: [
      {
        name: "shapes",
        parents: ["geometry"],
        places: [{ kind: "folder" as const, place: "packages/a/src/shapes" }],
        unmatched: [],
      },
      {
        name: "geometry",
        parents: [],
        places: [{ kind: "file" as const, place: "packages/a/src/point.ts" }],
        unmatched: [],
      },
      {
        name: "angles",
        parents: [],
        places: [
          { kind: "symbol" as const, place: "packages/a/src/turn.ts#radians" },
        ],
        unmatched: [],
      },
    ],
    placements: {
      "file:packages/a/src/point.ts": {
        away: { shared: 2, total: 5, unindexed: 1 },
        domainLabel: "departs" as const,
        domains: ["geometry"],
        level: "file" as const,
        package: "@s/a",
        place: "packages/a/src/point.ts",
        placementLabel: "departs" as const,
        sharedDomains: ["geometry"],
      },
      "file:packages/a/src/shapes/box.ts": {
        away: { shared: 3, total: 3, unindexed: 0 },
        domainLabel: "shares-domain" as const,
        domains: ["geometry", "shapes"],
        level: "file" as const,
        package: "@s/a",
        place: "packages/a/src/shapes/box.ts",
        placementLabel: "departs" as const,
        sharedDomains: ["shapes"],
      },
    },
  },
  nesting: {
    folders: [
      {
        fileCounts: { descendant: 3, direct: 3 },
        id: "packages/a/src/shapes",
        package: "@s/a",
        packageRoot: false,
        parent: "packages/a/src",
        pathRegion: "shapes",
      },
      {
        fileCounts: { descendant: 1, direct: 1 },
        id: "packages/a/scripts",
        package: "@s/a",
        packageRoot: false,
        parent: "packages/a",
      },
    ],
    pathRegions: [
      { files: 3, id: "shapes", package: "@s/a", primaryFiles: 3 },
      { files: 2, id: ".", package: "@s/a", primaryFiles: 2 },
      { files: 4, id: "lib", package: "@s/a", primaryFiles: 4 },
    ],
    seams: [
      seam("shapes", "lib", 4),
      seam(".", "shapes", 9),
      seam(".", "lib", 1),
    ],
  },
};

const island = { folder: "packages/a", id: "@s/a" } as Territory;

it("names a file's path region, and nothing where the internals list none", () => {
  expect(pathRegionText(atlas, "packages/a/src/shapes")).toBe(
    "path region shapes"
  );
  expect(pathRegionText(atlas, "packages/a/scripts")).toBeUndefined();
});

it("counts an island's path regions and names its two strongest seams", () => {
  expect(islandNestingText(atlas, island)).toBe(
    "3 path regions · seams . → shapes 9 module edges, shapes → lib 4"
  );
  expect(
    islandNestingText(atlas, { ...island, id: "@s/b" } as Territory)
  ).toBeUndefined();
});

it("finds a place's domains from the facets above it, with the domains they nest in", () => {
  expect(domainsText(atlas, "packages/a/src/shapes/box.ts")).toBe(
    "domains: geometry, shapes"
  );
  expect(domainsText(atlas, "packages/a/src/point.ts")).toBe(
    "domains: geometry"
  );
  expect(domainsText(atlas, "packages/a/src/other.ts")).toBeUndefined();
});

it("finds a symbol's domains: a file facet covers its symbols, and a symbol facet names only its own", () => {
  expect(domainsText(atlas, "packages/a/src/point.ts#Point")).toBe(
    "domains: geometry"
  );
  expect(domainsText(atlas, "packages/a/src/turn.ts#radians")).toBe(
    "domains: angles"
  );
  expect(domainsText(atlas, "packages/a/src/turn.ts#degrees")).toBeUndefined();
  expect(domainsText(atlas, "packages/a/src/turn.ts")).toBeUndefined();
});

it("tells a domain departure from a place that shares its domains with every consumer", () => {
  expect(domainLabelText(atlas, "file:packages/a/src/point.ts")).toBe(
    "domain departure: 2 of 5 consumer modules in other packages share its domains; 1 consumer outside the module index can't be shown to share them"
  );
  expect(domainLabelText(atlas, "file:packages/a/src/shapes/box.ts")).toBe(
    "shares shapes with every consumer"
  );
  expect(
    domainLabelText(atlas, "file:packages/a/src/other.ts")
  ).toBeUndefined();
});
