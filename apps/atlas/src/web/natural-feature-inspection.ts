import type {
  FeaturePoint,
  Lake,
  Marsh,
  NaturalFeatures,
} from "./natural-features";
import type { RiverRun } from "./river-network";

export type NaturalFeature =
  | { kind: "lake"; lake: Lake }
  | { kind: "marsh"; marsh: Marsh }
  | { kind: "river"; river: RiverRun };

export function featureIdentity(feature: NaturalFeature | undefined): string {
  if (!feature) {
    return "";
  }
  if (feature.kind === "lake") {
    return `lake:${feature.lake.file.id}`;
  }
  if (feature.kind === "marsh") {
    return `marsh:${feature.marsh.region.id}`;
  }
  const [first] = feature.river.points;
  return `river:${feature.river.streams.map((stream) => `${stream.from}:${stream.to}`).join("|")}:${first?.x},${first?.y}`;
}

export function featureText(feature: NaturalFeature) {
  if (feature.kind === "lake") {
    const { file, consumers } = feature.lake;
    return {
      detail: `Commons lake · ${file.incoming} incoming imports · Drawn on by ${consumers.map((item) => item.label).join(", ") || "responsibilities not resolved in this report"}.`,
      title: file.path,
    };
  }
  if (feature.kind === "marsh") {
    return {
      detail:
        "Unresolved belonging · Reeds mark uncertainty, not a defect. Dotted drains suggest recorded candidates, not imports.",
      title: feature.marsh.region.label,
    };
  }
  const { river } = feature;
  return {
    detail: `${river.moduleEdges} module ${river.moduleEdges === 1 ? "edge" : "edges"} · ${river.streams.map((stream) => `${stream.consumerLabel} imports from ${stream.supplierLabel}`).join("; ")}. Water is drawn from supplier to consumer.`,
    title: river.streams.length > 1 ? "Shared river" : "District stream",
  };
}

function distanceToSegment(
  point: FeaturePoint,
  a: FeaturePoint,
  b: FeaturePoint
) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)
    )
  );
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

function inside(point: FeaturePoint, polygon: FeaturePoint[]) {
  let result = false;
  for (let i = 0; i < polygon.length; i += 1) {
    const j = (i + polygon.length - 1) % polygon.length;
    const a = polygon[i],
      b = polygon[j];
    if (
      a &&
      b &&
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      result = !result;
    }
  }
  return result;
}

/** File and declaration hits take priority; this uses the same fitted drawing. */
export function hitNaturalFeature(
  features: NaturalFeatures,
  point: FeaturePoint,
  pixels: number,
  streams: boolean
): NaturalFeature | undefined {
  const lake = features.lakes.find((item) => inside(point, item.shore));
  if (lake) {
    return { kind: "lake", lake };
  }
  if (streams) {
    const river = features.rivers.find((run) =>
      run.points.some(
        (end, i) =>
          i > 0 &&
          distanceToSegment(point, run.points[i - 1] ?? end, end) <
            Math.max(run.width / 2, 4 / pixels)
      )
    );
    if (river) {
      return { kind: "river", river };
    }
  }
  const marsh = features.marshes.find((item) =>
    item.tufts.some(
      (tuft) => Math.hypot(tuft.x - point.x, tuft.y - point.y) < 3 / pixels
    )
  );
  return marsh ? { kind: "marsh", marsh } : undefined;
}
