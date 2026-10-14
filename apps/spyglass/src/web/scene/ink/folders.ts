import type { FolderCell } from "../../folder-sectors";
import type { SpyglassData, Territory } from "../../types";
import { chartTilt, type InkView } from "../exploration";
import { enteredAt, inkStyle } from "../ink-ladder";
import { traceLand } from "../paint-paper";
import type { InkState } from "./state";

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
  belonging: InkState["belonging"] | undefined
): boolean {
  return !(
    belonging?.territory.id === territory.id &&
    belonging.territory.files !== territory.files
  );
}

/** Whether an island reaches into the view, by its radius; every island without one. */
export function inView(
  territory: Territory,
  view: InkView | undefined
): boolean {
  return (
    !view ||
    (Math.abs(territory.x - view.x) <= view.width / 2 + territory.radius &&
      Math.abs(territory.y - view.y) <= view.height / 2 + territory.radius)
  );
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
  const cuts: [number, number, number, number][] = [];
  const visit = (cell: FolderCell, depth: number) => {
    if (pixels < cutShownFrom(depth)) {
      return;
    }
    for (const cut of cell.splits) {
      cuts.push(
        cut.axis === "x"
          ? [
              territory.x + cut.at,
              territory.y + cut.from,
              territory.x + cut.at,
              territory.y + cut.to,
            ]
          : [
              territory.x + cut.from,
              territory.y + cut.at,
              territory.x + cut.to,
              territory.y + cut.at,
            ]
      );
    }
    for (const child of cell.folders) {
      visit(child, depth + 1);
    }
  };
  visit(branchingCell(tree), 0);
  return cuts;
}

/**
 * Folders inside an island, from island zoom: a faint line on each cut
 * between sibling folders, from the island's first branching folder, deeper
 * cuts as the camera closes in, clipped to land. Hidden on an island whose
 * files "Group files by responsibility" has rearranged. The folders' names
 * are labels (`labels.ts`).
 */
export function paintFolders(state: InkState): void {
  const { belonging, ctx, data, pixels, view } = state;
  if (pixels < enteredAt) {
    return;
  }
  const pen = inkStyle("folder-cell");
  ctx.save();
  ctx.beginPath();
  traceLand(ctx, data);
  ctx.clip("evenodd");
  ctx.strokeStyle = pen.hue;
  ctx.setLineDash([]);
  const width = pen.weight / pixels;
  for (const territory of data.territories) {
    if (!(inView(territory, view) && cellsShown(territory, belonging))) {
      continue;
    }
    for (const [x0, y0, x1, y1] of folderCuts(data, territory, pixels)) {
      // The tilted camera foreshortens north–south, so a cut running east to
      // west is widened by as much to keep its weight on screen.
      ctx.lineWidth = y0 === y1 ? width / Math.cos(chartTilt) : width;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
  ctx.restore();
}
