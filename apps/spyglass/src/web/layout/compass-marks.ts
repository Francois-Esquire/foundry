import type { SpyglassData } from "../data/types";
import { inks } from "../ladder/ink-ladder";
import { compassCentre } from "./compass";
import type { Mark } from "./marks";

/** The rose, in map units: its circle's radius, and a point's reach, half width and tail. */
const rose = { circle: 23, halfWidth: 4, reach: 35, tail: 8 } as const;
/** The rose's outline pen, in CSS pixels: the painter's 0.65 units at overview, where the rose is seen. */
const rosePen = 0.65;
const circleSegments = 48;

type Point = [number, number];

/** One point of the rose, turned clockwise by `turn` radians about the centre, as a closed ring. */
function roseRing(cx: number, cy: number, turn: number): Point[] {
  const corners: Point[] = [
    [0, -rose.reach],
    [rose.halfWidth, 0],
    [0, rose.tail],
    [-rose.halfWidth, 0],
  ];
  const ring = corners.map(
    ([x, y]): Point => [
      cx + x * Math.cos(turn) - y * Math.sin(turn),
      cy + x * Math.sin(turn) + y * Math.cos(turn),
    ]
  );
  return [...ring, ring[0] ?? [cx, cy]];
}

/**
 * The compass rose at the chart's north-east corner, which opens chart
 * settings: a circle and eight points, the cardinal four filled and the
 * rest outlined, in map units so it scales with the zoom as the painted
 * one did; its "N" is lettered by the labels layer. Flat on the sea, where
 * no land stands. Built once per chart.
 */
export function compassMarks(
  data: Pick<SpyglassData, "height" | "width">
): Mark[] {
  const { x, y } = compassCentre(data);
  const circle: number[] = [];
  for (let i = 0; i <= circleSegments; i += 1) {
    const angle = (i / circleSegments) * Math.PI * 2;
    circle.push(
      x + rose.circle * Math.cos(angle),
      y + rose.circle * Math.sin(angle)
    );
  }
  const marks: Mark[] = [
    {
      alpha: 1,
      colour: inks.compass,
      kind: "stroke",
      points: circle,
      width: rosePen,
    },
  ];
  for (let i = 0; i < 8; i += 1) {
    const ring = roseRing(x, y, (i * Math.PI) / 4);
    if (i % 2 === 0) {
      marks.push({
        alpha: 1,
        colour: inks.compass,
        kind: "fill",
        polygon: [ring],
      });
    } else {
      marks.push({
        alpha: 1,
        colour: inks.compass,
        kind: "stroke",
        points: ring.flat(),
        width: rosePen,
      });
    }
  }
  return marks;
}
