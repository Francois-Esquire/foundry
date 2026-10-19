import type { FolderCell, SpyglassData, Territory } from "../data/types";
import { enteredAt } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import type { BelongingLayer } from "./belonging";
import { clipPolyline } from "./clip";
import type { MarkAlpha, Stroke } from "./marks";
import { inkedStroke, runPoints } from "./marks";

/**
 * From how many pixels a unit a level of cuts shows: the first branching
 * folder's own from island zoom, its subfolders' from 8, and each level
 * below 6 more, so a deep tree opens one level at a time.
 */
export function cutShownFrom(depth: number): number {
  return depth === 0 ? enteredAt : 8 + 6 * (depth - 1);
}

/**
 * The first folder of an island with more than one subfolder: the package
 * folder, or, when it holds one subfolder, as most hold `src` beside a few
 * root files, the first one below with more. A package with no such folder
 * branches at its deepest single subfolder.
 */
export function branchingCell(tree: FolderCell): FolderCell {
  let cell = tree;
  while (cell.folders.length === 1) {
    const [only] = cell.folders;
    if (!only) {
      break;
    }
    cell = only;
  }
  return cell;
}

/**
 * The folders named on an island: the branching folder's subfolders, each
 * with its name below the branching folder ("web" in `src`) and its cell.
 */
export function namedFolders(
  tree: FolderCell
): { cell: FolderCell; name: string }[] {
  const branch = branchingCell(tree);
  const prefix = branch.folder ? `${branch.folder}/` : "";
  return branch.folders.map((cell) => ({
    cell,
    name: cell.folder.slice(prefix.length),
  }));
}

/**
 * Whether an island's files sit in their cells: not while "Group files by
 * responsibility" has rearranged them, which hands the belonging layer a
 * territory with files of its own.
 */
export function cellsShown(
  territory: Territory,
  belonging: Pick<BelongingLayer, "territory"> | null | undefined
): boolean {
  return !(
    belonging?.territory.id === territory.id &&
    belonging.territory.files !== territory.files
  );
}

/** One cut of an island's tree, in island units, with how deep in the tree it was made. */
interface Cut {
  depth: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Every cut below the branching folder, each with its depth there. */
function cutsOf(tree: FolderCell): Cut[] {
  const cuts: Cut[] = [];
  const visit = (cell: FolderCell, depth: number) => {
    for (const cut of cell.splits) {
      cuts.push(
        cut.axis === "x"
          ? { depth, x0: cut.at, x1: cut.at, y0: cut.from, y1: cut.to }
          : { depth, x0: cut.from, x1: cut.to, y0: cut.at, y1: cut.at }
      );
    }
    for (const child of cell.folders) {
      visit(child, depth + 1);
    }
  };
  visit(branchingCell(tree), 0);
  return cuts;
}

/** Each cut to draw on an island at this zoom, in world units: a line across the sites its folder divided. */
export function folderCuts(
  data: Pick<SpyglassData, "folderCells">,
  territory: Territory,
  pixels: number
): [number, number, number, number][] {
  const tree = data.folderCells[territory.id];
  if (!tree || pixels < enteredAt) {
    return [];
  }
  return cutsOf(tree)
    .filter((cut) => pixels >= cutShownFrom(cut.depth))
    .map((cut) => [
      territory.x + cut.x0,
      territory.y + cut.y0,
      territory.x + cut.x1,
      territory.y + cut.y1,
    ]);
}

/** One alpha per depth, shared by every cut at it: shown from its zoom, so the tree opens through uniforms. */
const depthAlphas: MarkAlpha[] = [];

function cutAlpha(depth: number): MarkAlpha {
  let alpha = depthAlphas[depth];
  if (!alpha) {
    const from = cutShownFrom(depth);
    alpha = (pixels: number) => (pixels >= from ? 1 : 0);
    depthAlphas[depth] = alpha;
  }
  return alpha;
}

/**
 * Folders inside an island, from island zoom: a faint line on each cut
 * between sibling folders, from the island's first branching folder, deeper
 * cuts as the camera closes in, cut to the land and draped on it. Hidden on
 * an island whose files "Group files by responsibility" has rearranged. The
 * folders' names are labels (`layout/label-candidates.ts`). Every island's cuts
 * are built, at every depth; each depth's alpha brings it in at its zoom.
 */
export function folderMarks(
  data: Pick<SpyglassData, "folderCells" | "territories">,
  belonging: Pick<BelongingLayer, "territory"> | null
): Stroke[] {
  const pen = inkStyle("folder-cell");
  const marks: Stroke[] = [];
  for (const territory of data.territories) {
    const tree = data.folderCells[territory.id];
    if (!(tree && cellsShown(territory, belonging))) {
      continue;
    }
    for (const cut of cutsOf(tree)) {
      const alpha = cutAlpha(cut.depth);
      for (const piece of clipPolyline(
        [cut.x0, cut.y0, cut.x1, cut.y1],
        territory.coast
      )) {
        marks.push(
          inkedStroke(pen, runPoints(piece, territory.x, territory.y), {
            alpha,
            cap: "butt",
            on: territory,
          })
        );
      }
    }
  }
  return marks;
}
