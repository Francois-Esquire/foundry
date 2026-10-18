import { assert, expect, it } from "vitest";
import type { FolderCell, SpyglassFile } from "../../src/web/data/types";
import {
  clusterFolders,
  districtsOfGroups,
  folderWithin,
  settleFiles,
} from "../../src/web/folder-sectors";
import { landContours } from "../../src/web/geography";
import { loadSpyglass } from "../helpers/reference-spyglass";

const file = (path: string): SpyglassFile => ({
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

/** Each group's bounding box, by key. */
function boxes(
  files: readonly SpyglassFile[],
  key: (file: SpyglassFile) => string
) {
  const found = new Map<string, [number, number, number, number]>();
  for (const { x, y, ...rest } of files) {
    const id = key({ ...rest, x, y });
    const [x0, y0, x1, y1] = found.get(id) ?? [x, y, x, y];
    found.set(id, [
      Math.min(x0, x),
      Math.min(y0, y),
      Math.max(x1, x),
      Math.max(y1, y),
    ]);
  }
  return [...found.values()];
}

/** Whether no two boxes overlap: each group sits in a cell of its own. */
function apart(found: [number, number, number, number][]) {
  return found.every((a, i) =>
    found
      .slice(i + 1)
      .every((b) => a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1])
  );
}

const island = [
  "pkg/package.json",
  "pkg/src/a.ts",
  "pkg/src/b.ts",
  "pkg/src/web/c.ts",
  "pkg/src/web/d.ts",
  "pkg/src/web/scene/e.ts",
  "pkg/src/web/scene/f.ts",
  "pkg/src/web/scene/g.ts",
  "pkg/test/a.test.ts",
  "pkg/test/b.test.ts",
  "pkg/test/web/c.test.ts",
].map(file);

it("reads a file's folder below its package's", () => {
  expect(folderWithin("pkg/src/web", "pkg")).toBe("src/web");
  expect(folderWithin("pkg", "pkg")).toBe("");
  expect(folderWithin("other/src", "pkg")).toBe("other/src");
});

it("gives every folder a cell of its own, from paths alone, the same every time", () => {
  const files = structuredClone(island);
  settleFiles(files, 60, "pkg");
  const again = structuredClone(island).reverse();
  settleFiles(again, 60, "pkg");
  expect(again.reverse()).toEqual(files);
  expect(new Set(files.map((f) => `${f.x},${f.y}`)).size).toBe(files.length);
  expect(apart(boxes(files, (f) => f.directory))).toBe(true);
  // Sibling folders side by side: src's files, then src/web's, sit between
  // the package root's and test's along one axis or the other.
  expect(apart(boxes(files, (f) => f.directory.split("/")[1] ?? ""))).toBe(
    true
  );
});

it("lays the reference spyglass out by folder: one coast per island, and most nearest neighbours in the same folder", async () => {
  const data = await loadSpyglass();
  let matched = 0;
  let total = 0;
  for (const territory of data.territories) {
    const files = territory.files.map((f) => ({ ...f }));
    settleFiles(files, territory.radius, territory.folder);
    expect(apart(boxes(files, (f) => f.directory)), territory.id).toBe(true);
    if (files.length) {
      expect(
        landContours(files, territory.radius)[1],
        territory.id
      ).toHaveLength(1);
    }
    for (const f of files) {
      const nearest = files
        .filter((other) => other !== f)
        .sort(
          (a, b) =>
            (a.x - f.x) ** 2 +
            (a.y - f.y) ** 2 -
            ((b.x - f.x) ** 2 + (b.y - f.y) ** 2)
        )
        .slice(0, 3);
      total += nearest.length;
      matched += nearest.filter(
        (other) => other.directory === f.directory
      ).length;
    }
  }
  // 0.57 under the import-pulled layout; 0.14 with positions shuffled.
  expect(matched / total).toBeGreaterThan(0.7);
});

it("orders a folder's files by district on the same sites path order gives it, one district rank for the island", () => {
  const byPath = structuredClone(island);
  settleFiles(byPath, 60, "pkg");
  // "big" holds the most files, so it comes first in every folder it reaches.
  const district = new Map([
    ["pkg/src/web/scene/e.ts", "small"],
    ["pkg/src/web/scene/f.ts", "big"],
    ["pkg/src/web/scene/g.ts", "big"],
    ["pkg/test/a.test.ts", "small"],
    ["pkg/test/b.test.ts", "big"],
    ["pkg/src/a.ts", "big"],
  ]);
  const districtOf = (f: SpyglassFile) => district.get(f.path);
  const arranged = structuredClone(island);
  settleFiles(arranged, 60, "pkg", districtOf);
  const sites = (list: readonly SpyglassFile[], folder: string) =>
    list
      .filter((f) => f.directory === folder)
      .map((f) => `${f.x},${f.y}`)
      .sort();
  // Cells, and so the coast, do not depend on the districts.
  for (const folder of new Set(island.map((f) => f.directory))) {
    expect(sites(arranged, folder)).toEqual(sites(byPath, folder));
  }
  const again = structuredClone(island).reverse();
  settleFiles(again, 60, "pkg", districtOf);
  expect(again.reverse()).toEqual(arranged);
  const scene = arranged.filter((f) => f.directory === "pkg/src/web/scene");
  expect(apart(boxes(scene, (f) => district.get(f.path) ?? ""))).toBe(true);
});

it("finds each file's district in the lens's groups, the first by id where two hold it", () => {
  const districtOf = districtsOfGroups([
    { id: "responsibility-group:b", modules: ["pkg/src/a.ts", "pkg/src/b.ts"] },
    { id: "responsibility-group:a", modules: ["pkg/src/b.ts"] },
  ]);
  const [, a, b, c] = island;
  expect(a && districtOf(a)).toBe("responsibility-group:b");
  expect(b && districtOf(b)).toBe("responsibility-group:a");
  expect(c && districtOf(c)).toBeUndefined();
});

type Point = readonly [number, number];

/** The convex hull of `points`, counter-clockwise (Andrew's monotone chain). */
function hull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) {
    return sorted;
  }
  const turn = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (ordered: Point[]) => {
    const out: Point[] = [];
    for (const p of ordered) {
      while (out.length >= 2) {
        const a = out.at(-2);
        const b = out.at(-1);
        if (!(a && b) || turn(a, b, p) > 0) {
          break;
        }
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...chain(sorted), ...chain([...sorted].reverse())];
}

/** Whether two convex hulls are strictly apart: some edge normal of either separates them (the separating axis theorem). */
function hullsApart(a: readonly Point[], b: readonly Point[]): boolean {
  const axes = [a, b].flatMap((polygon) =>
    polygon.map((p, i) => {
      const q = polygon[(i + 1) % polygon.length] ?? p;
      return [q[1] - p[1], p[0] - q[0]] as const;
    })
  );
  // Two points or fewer have no edges worth testing: try both coordinate axes too.
  axes.push([1, 0], [0, 1]);
  return axes.some(([nx, ny]) => {
    const project = (polygon: readonly Point[]) =>
      polygon.map(([x, y]) => x * nx + y * ny);
    const pa = project(a);
    const pb = project(b);
    return (
      Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)
    );
  });
}

/** Within every cell, its own files' hull and each subfolder's hull are pairwise apart. */
function cellsApart(
  cell: FolderCell,
  files: readonly SpyglassFile[],
  root: string
): string[] {
  const own = files
    .filter((f) => folderWithin(f.directory, root) === cell.folder)
    .map((f): Point => [f.x, f.y]);
  const groups = [
    ...(own.length ? [{ name: `${cell.folder}/`, points: own }] : []),
    ...cell.folders.map((child) => ({
      name: child.folder,
      points: child.sites.map(({ x, y }): Point => [x, y]),
    })),
  ];
  const clashes = groups.flatMap((a, i) =>
    groups
      .slice(i + 1)
      .filter((b) => !hullsApart(hull(a.points), hull(b.points)))
      .map((b) => `${a.name} ~ ${b.name}`)
  );
  return [
    ...clashes,
    ...cell.folders.flatMap((child) => cellsApart(child, files, root)),
  ];
}

function findCell(cell: FolderCell, folder: string): FolderCell | undefined {
  if (cell.folder === folder) {
    return cell;
  }
  for (const child of cell.folders) {
    const found = findCell(child, folder);
    if (found) {
      return found;
    }
  }
}

it("keeps every cell's hull apart from its siblings' on the reference spyglass, and covers every file", async () => {
  const data = await loadSpyglass();
  for (const territory of data.territories) {
    const files = territory.files.map((f) => ({ ...f }));
    const tree = settleFiles(files, territory.radius, territory.folder);
    expect(tree.sites).toHaveLength(files.length);
    expect(cellsApart(tree, files, territory.folder), territory.id).toEqual([]);
  }
});

it("places one file, with no cut", () => {
  const [only] = island;
  assert(only);
  const files = [{ ...only }];
  const tree = settleFiles(files, 30, "pkg");
  expect(tree.splits).toEqual([]);
  expect(files.every((f) => Number.isFinite(f.x) && Number.isFinite(f.y))).toBe(
    true
  );
  expect(landContours(files, 30)[1]).toHaveLength(1);
});

it("fills one folder of many files as one cell, one piece of land", () => {
  const files = Array.from({ length: 80 }, (_, i) =>
    file(`pkg/src/f${String(i).padStart(2, "0")}.ts`)
  );
  const tree = settleFiles(files, 80, "pkg");
  const [src] = tree.folders;
  expect(tree.folders.map((cell) => cell.folder)).toEqual(["src"]);
  // One block in each: nothing to cut between.
  expect(tree.splits).toEqual([]);
  expect(src?.splits).toEqual([]);
  expect(new Set(files.map((f) => `${f.x},${f.y}`)).size).toBe(80);
  expect(landContours(files, 80)[1]).toHaveLength(1);
});

it("nests cells as deep as the folders go", () => {
  const files = [
    "pkg/a/b/c/d/e/f/g/x.ts",
    "pkg/a/b/c/d/e/f/g/y.ts",
    "pkg/a/b/c/z.ts",
    "pkg/a/w.ts",
    "pkg/v.ts",
  ].map(file);
  const tree = settleFiles(files, 40, "pkg");
  expect(findCell(tree, "a/b/c/d/e/f/g")?.sites).toHaveLength(2);
  expect(findCell(tree, "a/b/c")?.sites).toHaveLength(3);
  expect(cellsApart(tree, files, "pkg")).toEqual([]);
  expect(files.every((f) => Number.isFinite(f.x) && Number.isFinite(f.y))).toBe(
    true
  );
});

it("gives a file outside the package's folder a cell by its own path", () => {
  const files = ["pkg/src/a.ts", "pkg/src/b.ts", "other/c.ts"].map(file);
  const tree = settleFiles(files, 40, "pkg");
  expect(tree.folders.map((cell) => cell.folder).sort()).toEqual([
    "other",
    "src",
  ]);
  expect(tree.splits).toHaveLength(1);
  expect(cellsApart(tree, files, "pkg")).toEqual([]);
});

type Cut = FolderCell["splits"][number];

/** Whether the straight path from `p` to `q` crosses the cut. */
function crosses(
  cut: Cut,
  p: { x: number; y: number },
  q: { x: number; y: number }
) {
  const along = (point: { x: number; y: number }) =>
    cut.axis === "x" ? point.x : point.y;
  const other = (point: { x: number; y: number }) =>
    cut.axis === "x" ? point.y : point.x;
  const a = along(p) - cut.at;
  const b = along(q) - cut.at;
  if (a * b > 0) {
    return false;
  }
  const t = a === b ? 0 : a / (a - b);
  const at = other(p) + (other(q) - other(p)) * t;
  return at >= Math.min(cut.from, cut.to) && at <= Math.max(cut.from, cut.to);
}

it("draws each cut across the whole region its split divided, so a drawn cut lies between every two sites of different blocks", async () => {
  const data = await loadSpyglass();
  for (const territory of data.territories) {
    const files = territory.files.map((f) => ({ ...f }));
    const tree = settleFiles(files, territory.radius, territory.folder);
    const visit = (cell: FolderCell) => {
      const own = files.filter(
        (f) => folderWithin(f.directory, territory.folder) === cell.folder
      );
      const blocks = [
        ...(own.length ? [own] : []),
        ...cell.folders.map((child) => child.sites),
      ].map((block) => block.slice(0, 12));
      for (const [i, a] of blocks.entries()) {
        for (const b of blocks.slice(i + 1)) {
          for (const p of a) {
            for (const q of b) {
              expect(
                cell.splits.some((cut) => crosses(cut, p, q)),
                `${territory.id} ${cell.folder}`
              ).toBe(true);
            }
          }
        }
      }
      for (const child of cell.folders) {
        visit(child);
      }
    };
    visit(tree);
  }
});

it("keeps headlands and bays on a densely populated island instead of a disc", () => {
  const files = Array.from({ length: 500 }, (_, i) =>
    file(`pkg/src/file-${i}.ts`)
  );
  settleFiles(files, 120, "pkg");
  const coast = landContours(files, 120)[1]?.[0]?.[0] ?? [];
  const radii = coast.map(([x, y]) => Math.hypot(x, y));
  expect(coast.length).toBeGreaterThan(100);
  expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(1.3);
});

it("keeps folder navigation on real clusters without moving files or inventing rectangular cuts", () => {
  const files = island.map((entry, i) => ({
    ...entry,
    x: i * 3 - 10,
    y: (i % 3) - 5,
  }));
  const before = structuredClone(files);
  const tree = clusterFolders(files, "pkg");
  expect(files).toEqual(before);
  const visit = (cell: FolderCell) => {
    expect(cell.spatial).toBe("cluster");
    expect(cell.splits).toEqual([]);
    const members = files.filter(
      (entry) =>
        !cell.folder ||
        folderWithin(entry.directory, "pkg") === cell.folder ||
        folderWithin(entry.directory, "pkg").startsWith(`${cell.folder}/`)
    );
    expect(cell.sites).toEqual(members.map(({ x, y }) => ({ x, y })));
    for (const child of cell.folders) {
      visit(child);
    }
  };
  visit(tree);
});
