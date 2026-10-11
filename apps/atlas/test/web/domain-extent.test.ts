import assert from "node:assert/strict";
import { expect, it } from "vitest";
import type { DomainMatch } from "../../src/lib/lenses/domains-types";
import { domainExtent } from "../../src/web/domain-extent";
import { settleFiles } from "../../src/web/folder-sectors";
import { relayoutAtlas } from "../../src/web/geography";
import { toCoast, unionOutline } from "../../src/web/scene/ink/domain";
import type { AtlasData, AtlasFile, Territory } from "../../src/web/types";
import { loadAtlas } from "../helpers/reference-atlas";

const file = (path: string): AtlasFile => ({
  directory: path.slice(0, path.lastIndexOf("/")),
  highFanIn: false,
  id: path,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path,
  x: 0,
  y: 0,
});

function island(id: string, folder: string, paths: string[]): Territory {
  return {
    files: paths.map((path) => file(`${folder}/${path}`)),
    folder,
    id,
    label: id,
    radius: 60,
    x: 0,
    y: 0,
  } as Territory;
}

const core = island("core", "packages/core", [
  "src/a.ts",
  "src/node/b.ts",
  "src/node/c.ts",
  "src/node/deep/d.ts",
  "src/web/e.ts",
  "src/web/f.ts",
]);
const lib = island("lib", "packages/lib", ["src/x.ts", "src/y.ts"]);
const app = island("app", "apps/app", ["src/main.ts"]);

const domain = (
  name: string,
  places: DomainMatch["places"],
  extra: Partial<DomainMatch> = {}
): DomainMatch => ({ name, parents: [], places, unmatched: [], ...extra });

function atlas(declared: DomainMatch[]): AtlasData {
  const territories = [core, lib, app];
  return {
    domains: {
      declared,
      placements: {
        "file:packages/lib/src/x.ts": {
          away: { shared: 2, total: 2, unindexed: 0 },
          domainLabel: "shares-domain",
          domains: ["runtime", "store"],
          level: "file",
          package: "lib",
          place: "packages/lib/src/x.ts",
          placementLabel: "departs",
          sharedDomains: ["runtime"],
        },
        "folder:packages/core/src/node": {
          away: { shared: 0, total: 3, unindexed: 0 },
          domainLabel: "departs",
          domains: ["runtime"],
          level: "folder",
          package: "core",
          place: "packages/core/src/node",
          placementLabel: "departs",
          sharedDomains: [],
        },
      },
    },
    folderCells: Object.fromEntries(
      territories.map((t) => [t.id, settleFiles(t.files, 60, t.folder)])
    ),
    territories,
  } as unknown as AtlasData;
}

it("draws nothing for a domain the atlas does not declare", () => {
  expect(domainExtent(atlas([]), "runtime")).toBeNull();
});

it("covers the topmost folder cells, the files named alone, and the islands covered whole, with its nested domains' facets", () => {
  const data = atlas([
    domain("runtime", [
      { kind: "folder", place: "packages/core/src/node" },
      { kind: "folder", place: "packages/core/src/node/deep" },
      { kind: "file", place: "packages/core/src/node/b.ts" },
      { kind: "folder", place: "apps" },
    ]),
    domain(
      "store",
      [
        { kind: "file", place: "packages/lib/src/x.ts" },
        { kind: "symbol", place: "packages/lib/src/y.ts#Store" },
      ],
      { parents: ["runtime"], unmatched: ["packages/lib/src/gone"] }
    ),
  ]);
  const extent = domainExtent(data, "runtime");
  expect(extent?.islands.map((item) => item.territory.id)).toEqual([
    "core",
    "lib",
    "app",
  ]);
  const [onCore, onLib, onApp] = extent?.islands ?? [];
  // A cell below a covered cell, and a file inside one, are not drawn twice.
  expect(onCore?.cells.map((cell) => cell.folder)).toEqual(["src/node"]);
  expect(onCore?.files).toEqual([]);
  expect(onCore?.covered).toBe(3);
  expect(onCore?.whole).toBe(false);
  // The nested domain's file is the parent's too.
  expect(onLib?.files.map((item) => item.path)).toEqual([
    "packages/lib/src/x.ts",
  ]);
  // A folder facet above a package covers it whole.
  expect(onApp?.whole).toBe(true);
  expect(onApp?.covered).toBe(1);
  expect(extent?.symbols).toEqual(["packages/lib/src/y.ts#Store"]);
  expect(extent?.unmatched).toEqual(["packages/lib/src/gone"]);
  expect([...(extent?.explained ?? [])]).toEqual([
    "file:packages/lib/src/x.ts",
  ]);
  expect(extent?.departures).toBe(1);
  // The nested domain alone: the parent shares the departure, not it.
  const store = domainExtent(data, "store");
  expect(store?.islands.map((item) => item.territory.id)).toEqual(["lib"]);
  expect(store?.explained.size).toBe(0);
  expect(store?.departures).toBe(0);
  // Worked out once per atlas and domain.
  expect(domainExtent(data, "runtime")).toBe(extent);
});

it("covers a package whole by its package facet, and its files by a folder that has no cell", () => {
  const data = atlas([
    domain("whole", [{ kind: "package", place: "packages/lib" }]),
    domain("loose", [{ kind: "folder", place: "packages/core/src/web" }]),
  ]);
  expect(domainExtent(data, "whole")?.islands).toMatchObject([
    { cells: [], files: [], territory: lib, whole: true },
  ]);
  const withoutCells = { ...data, folderCells: {} } as AtlasData;
  expect(
    domainExtent(withoutCells, "loose")?.islands[0]?.files.map((f) => f.path)
  ).toEqual(["packages/core/src/web/e.ts", "packages/core/src/web/f.ts"]);
});

it("outlines a union of cell regions without the edge two of them share", () => {
  const left = { x0: 0, x1: 10, y0: 0, y1: 10 };
  const right = { x0: 10, x1: 20, y0: 0, y1: 4 };
  const outline = unionOutline([left, right]);
  // The shared stretch of x = 10, from 0 to 4, drops out; the rest stays.
  expect(outline).toContainEqual([10, 4, 10, 10]);
  expect(outline).not.toContainEqual([10, 0, 10, 10]);
  expect(outline.filter(([x0, , x1]) => x0 === 10 && x1 === 10)).toHaveLength(
    1
  );
  expect(unionOutline([left])).toHaveLength(4);
});

it("gives every cell the region its parent's cuts left it, meeting its siblings edge to edge", () => {
  const tree = settleFiles(core.files, 60, core.folder);
  const [src] = tree.folders;
  const [node, web] = src?.folders ?? [];
  expect(src?.region).toEqual(tree.region);
  expect(node && web).toBeTruthy();
  const touching =
    node?.region.x1 === web?.region.x0 || node?.region.y1 === web?.region.y0;
  expect(touching).toBe(true);
  for (const cell of [node, web]) {
    for (const site of cell?.sites ?? []) {
      expect(site.x).toBeGreaterThanOrEqual(cell?.region.x0 ?? 0);
      expect(site.x).toBeLessThanOrEqual(cell?.region.x1 ?? 0);
      expect(site.y).toBeGreaterThanOrEqual(cell?.region.y0 ?? 0);
      expect(site.y).toBeLessThanOrEqual(cell?.region.y1 ?? 0);
    }
  }
});

it("takes a cell on the island's box out past the coast, and keeps edges inside the box where they are", () => {
  const box = { x0: -10, x1: 10, y0: -10, y1: 10 };
  expect(toCoast({ x0: -10, x1: 0, y0: -10, y1: 10 }, box, 100)).toEqual({
    x0: -110,
    x1: 0,
    y0: -110,
    y1: 110,
  });
  expect(toCoast({ x0: -2, x1: 3, y0: -1, y1: 4 }, box, 100)).toEqual({
    x0: -2,
    x1: 3,
    y0: -1,
    y1: 4,
  });
});

it("works a domain out again for a relaid atlas, over its moved islands and the same cells", async () => {
  const data = await loadAtlas();
  const [territory] = data.territories;
  assert(territory);
  const declared: AtlasData = {
    ...data,
    domains: {
      declared: [
        domain("shapes", [{ kind: "package", place: territory.folder }]),
      ],
      placements: {},
    },
  };
  const before = domainExtent(declared, "shapes");
  const relaid = relayoutAtlas(declared, 80);
  const after = domainExtent(relaid, "shapes");
  expect(after).not.toBe(before);
  const moved = relaid.territories.find((item) => item.id === territory.id);
  expect(after?.islands[0]?.territory).toBe(moved);
  expect(after?.islands[0]?.territory).not.toBe(before?.islands[0]?.territory);
  expect(after?.islands.map((item) => item.covered)).toEqual(
    before?.islands.map((item) => item.covered)
  );
});
