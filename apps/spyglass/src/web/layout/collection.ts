import type { Crossing } from "../../lib/collection-types";
import type { SpyglassData } from "../data/types";
import { positionFoundations } from "./foundations";
import { chartSize, sideBySide } from "./geography";

/**
 * A collection's spyglass from its workspaces' spyglasses, each one frame,
 * qualified (`qualifySpyglassData`), in the collection's order: the frames side
 * by side (`sideBySide`), each moved whole with its former packages, their
 * islands, routes, edges, layers, cells and former packages joined, and the
 * crossings kept apart, in their own field. A route never crosses frames:
 * crossings are declared dependencies between workspaces, not import
 * routes.
 */
export function composeCollection(
  frames: readonly SpyglassData[],
  crossings: readonly Crossing[]
): SpyglassData {
  const packageLayers: SpyglassData["packageLayers"] = Object.assign(
    {},
    ...frames.map((frame) => frame.packageLayers)
  );
  const offsets = sideBySide(frames.map((frame) => frame.territories));
  const shifted = frames.map((frame, i) => {
    const { dx = 0, dy = 0 } = offsets[i] ?? {};
    return {
      ...frame,
      formerPackages: frame.formerPackages?.map((former) => ({
        ...former,
        x: former.x + dx,
        y: former.y + dy,
      })),
      territories: frame.territories.map((territory) => ({
        ...territory,
        x: territory.x + dx,
        y: territory.y + dy,
      })),
    };
  });
  const territories = shifted.flatMap((frame) => frame.territories);
  const formerPackages = shifted.flatMap((frame) => frame.formerPackages ?? []);
  return {
    coverage: frames.every((frame) => frame.coverage === "complete")
      ? "complete"
      : "partial",
    crossings,
    declaredDependencies: frames.flatMap(
      (frame) => frame.declaredDependencies ?? []
    ),
    dependencyCoverage: frames.every(
      (frame) => frame.dependencyCoverage === "complete"
    )
      ? "complete"
      : "partial",
    fileEdges: frames.flatMap((frame) => frame.fileEdges),
    folderCells: Object.assign({}, ...frames.map((frame) => frame.folderCells)),
    foundations: positionFoundations(
      frames.flatMap((frame) => frame.foundations ?? []),
      territories
    ),
    ...(formerPackages.length > 0 && { formerPackages }),
    frames: frames.flatMap((frame) => frame.frames),
    packageLayers,
    routes: frames.flatMap((frame) => frame.routes),
    territories,
    ...chartSize(territories),
  };
}
