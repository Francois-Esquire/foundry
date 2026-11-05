import type { Mark, Point, TextAnchors, TextTarget } from "./model.ts";

/** Infer a target without altering an ordinary sketch unless the user confirms it. */
export function interpretGesture(
  mark: Mark,
  first: Point,
  tip: Point,
  textAnchors: TextAnchors,
  selection: TextTarget | null
): { mark: Mark; suggestion: TextTarget | null } {
  if (mark.kind !== "arrow") {
    return {
      mark,
      suggestion: textAnchors.targetForStroke(
        mark.points.map((point) => ({
          x: first.x + point.x,
          y: first.y + point.y,
        }))
      ),
    };
  }
  const target = textAnchors.targetAtPoint(tip) ?? selection;
  const rect = target ? textAnchors.resolveTarget(target)?.[0] : null;
  if (target && rect) {
    return {
      mark: {
        ...mark,
        points: [
          { x: first.x - rect.x, y: first.y - (rect.y + rect.height / 2) },
        ],
        target,
      },
      suggestion: null,
    };
  }
  return { mark, suggestion: null };
}
