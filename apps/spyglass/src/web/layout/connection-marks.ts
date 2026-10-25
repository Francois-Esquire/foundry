import type { SpyglassData } from "../data/types";
import { inkStyle } from "../ladder/ink-table";
import type { Stroke } from "./marks";
import { inkedStroke } from "./marks";

/** How strongly a traced import is drawn. */
const tracedAlpha = 0.73;

/**
 * The traced imports of the selected file, when "Trace imports" is on and
 * no responsibility overlay has the island: a dashed line from the file to
 * each file it imports or is imported by, on any island, draped on the
 * chart so it follows the relief where it crosses land and lies on the sea
 * between islands. Nothing without a selected file.
 */
export function connectionMarks(
  data: Pick<SpyglassData, "fileEdges" | "territories">,
  fileId: string | null
): Stroke[] {
  if (!fileId) {
    return [];
  }
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
  const traced = inkStyle("traced-import");
  const marks: Stroke[] = [];
  for (const edge of data.fileEdges) {
    if (edge.source !== fileId && edge.target !== fileId) {
      continue;
    }
    const a = locations.get(edge.source);
    const b = locations.get(edge.target);
    if (!(a && b)) {
      continue;
    }
    marks.push(
      inkedStroke(traced, [a.x, a.y, b.x, b.y], {
        alpha: tracedAlpha,
        cap: "butt",
        on: "chart",
      })
    );
  }
  return marks;
}
