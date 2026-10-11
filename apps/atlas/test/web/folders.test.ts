import { expect, it } from "vitest";
import { settleFiles } from "../../src/web/folder-sectors";
import {
  branchingCell,
  cellsShown,
  cutShownFrom,
  folderCuts,
} from "../../src/web/scene/ink/folders";
import { enteredAt } from "../../src/web/scene/ink-ladder";
import type { AtlasFile, Territory } from "../../src/web/types";

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
  expect(
    cellsShown(territory, {
      regions: [],
      territory,
    })
  ).toBe(true);
  expect(
    cellsShown(territory, {
      regions: [],
      territory: { ...territory, files: files.map((f) => ({ ...f })) },
    })
  ).toBe(false);
});

it("opens a deep tree one level at a time, 6 pixels a unit apart past the subfolders'", () => {
  expect([0, 1, 2, 3, 4].map(cutShownFrom)).toEqual([enteredAt, 8, 14, 20, 26]);
});
