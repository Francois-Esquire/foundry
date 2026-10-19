import type { SpyglassData } from "../data/types";
import { inkStyle } from "../ladder/ink-table";
import { inkedStroke, type Mark } from "./marks";

/** Local dependencies stay bounded; selection gives a file's routes priority. */
export function dependencyRouteMarks(
  data: SpyglassData,
  selectedFile: string | null
): Mark[] {
  const locations = new Map(
    data.territories.flatMap((territory) =>
      territory.files.map(
        (file) =>
          [
            file.id,
            { x: territory.x + file.x, y: territory.y + file.y },
          ] as const
      )
    )
  );
  const edges = data.fileEdges
    .filter(
      (edge) =>
        !selectedFile ||
        edge.source === selectedFile ||
        edge.target === selectedFile
    )
    .slice()
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
    )
    .slice(0, 24);
  const style = inkStyle("traced-import");
  return edges.flatMap((edge) => {
    const from = locations.get(edge.source),
      to = locations.get(edge.target);
    if (!(from && to)) {
      return [];
    }
    return [
      inkedStroke(style, [from.x, from.y, to.x, to.y], {
        alpha: 0.65,
        cap: "round",
        on: "chart",
      }),
    ];
  });
}
