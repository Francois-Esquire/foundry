import { expect, it } from "vitest";
import type { SpyglassFile, Territory } from "../../src/web/data/types";
import { enteredAt } from "../../src/web/ladder/ink-ladder";
import { inkStyle } from "../../src/web/ladder/ink-table";
import { settleFiles } from "../../src/web/layout/folder-sectors";
import {
  branchingCell,
  cellsShown,
  cutShownFrom,
  folderCuts,
  folderMarks,
} from "../../src/web/layout/folders";
import { alphaAt } from "../../src/web/layout/marks";

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

const files = [
  "pkg/src/a.ts",
  "pkg/src/web/b.ts",
  "pkg/src/web/c.ts",
  "pkg/src/web/scene/d.ts",
  "pkg/src/web/scene/e.ts",
  "pkg/src/lib/f.ts",
  "pkg/src/lib/g.ts",
].map(file);
const tree = settleFiles(files, 60, "pkg");
const territory = {
  coast: [
    [
      [
        [-40, -40],
        [40, -40],
        [40, 40],
        [-40, 40],
        [-40, -40],
      ],
    ],
  ],
  files,
  folder: "pkg",
  id: "pkg",
  radius: 60,
  x: 100,
  y: 50,
} as Territory;
const data = { folderCells: { pkg: tree } };

it("starts at the first folder that divides: inside src when every file sits in it", () => {
  expect(tree.folder).toBe("");
  expect(branchingCell(tree).folder).toBe("src");
  expect(branchingCell(tree).folders.map((cell) => cell.folder)).toEqual([
    "src/lib",
    "src/web",
  ]);
});

it("draws the branching folder's cuts from island zoom, its subfolders' closer in, none at overview", () => {
  expect(folderCuts(data, territory, 1)).toEqual([]);
  const island = folderCuts(data, territory, enteredAt);
  expect(island).toHaveLength(branchingCell(tree).splits.length);
  expect(folderCuts(data, territory, 4)).toEqual(island);
  expect(folderCuts(data, territory, 8).length).toBeGreaterThan(island.length);
  // Cuts are in world units: the island's centre is added.
  const [cut] = island;
  const [first] = branchingCell(tree).splits;
  expect(cut?.[0]).toBe(
    first?.axis === "x"
      ? territory.x + first.at
      : territory.x + (first?.from ?? 0)
  );
});

it("hides the cells of an island whose files are rearranged by responsibility", () => {
  expect(cellsShown(territory, null)).toBe(true);
  expect(cellsShown(territory, { territory })).toBe(true);
  expect(
    cellsShown(territory, {
      territory: { ...territory, files: files.map((f) => ({ ...f })) },
    })
  ).toBe(false);
});

it("opens a deep tree one level at a time, 6 pixels a unit apart past the subfolders'", () => {
  expect([0, 1, 2, 3, 4].map(cutShownFrom)).toEqual([enteredAt, 8, 14, 20, 26]);
});

it("marks every cut cut to the land and draped on it, each depth coming in at its zoom, and none on a rearranged island", () => {
  const marks = folderMarks(
    { folderCells: { pkg: tree }, territories: [territory] },
    null
  );
  expect(marks.length).toBeGreaterThan(0);
  const pen = inkStyle("folder-cell");
  for (const mark of marks) {
    expect(mark).toMatchObject({
      cap: "butt",
      colour: pen.hue,
      on: territory,
      width: pen.weight,
    });
    for (let i = 0; i + 1 < mark.points.length; i += 2) {
      expect(Math.abs((mark.points[i] ?? 0) - territory.x)).toBeLessThanOrEqual(
        40
      );
      expect(
        Math.abs((mark.points[i + 1] ?? 0) - territory.y)
      ).toBeLessThanOrEqual(40);
    }
    expect(alphaAt(mark.alpha, 1)).toBe(0);
  }
  // The branching folder's cuts show from island zoom; deeper ones wait.
  const shown = (pixels: number) =>
    marks.filter((mark) => alphaAt(mark.alpha, pixels) === 1).length;
  expect(shown(enteredAt)).toBeGreaterThan(0);
  expect(shown(8)).toBeGreaterThan(shown(enteredAt));
  expect(new Set(marks.map((mark) => mark.alpha)).size).toBeLessThanOrEqual(3);
  expect(
    folderMarks(
      { folderCells: { pkg: tree }, territories: [territory] },
      { territory: { ...territory, files: files.map((f) => ({ ...f })) } }
    )
  ).toEqual([]);
});
