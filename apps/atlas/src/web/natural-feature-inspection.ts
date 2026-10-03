import type { Landmark } from "./landmarks";
import type { FeaturePoint, Marsh, NaturalFeatures } from "./natural-features";
import type { RiverRun } from "./river-network";

export type NaturalFeature =
  | { kind: "landmark"; landmark: Landmark }
  | { kind: "marsh"; marsh: Marsh }
  | { kind: "river"; river: RiverRun };

export function featureIdentity(feature: NaturalFeature | undefined): string {
  if (!feature) {
    return "";
  }
  if (feature.kind === "landmark") {
    return `landmark:${feature.landmark.file.id}`;
  }
  if (feature.kind === "marsh") {
    return `marsh:${feature.marsh.region.id}`;
  }
  const [first] = feature.river.points;
  return `river:${feature.river.streams.map((stream) => `${stream.from}:${stream.to}`).join("|")}:${first?.x},${first?.y}`;
}

export function featureText(feature: NaturalFeature) {
  if (feature.kind === "landmark") {
    return landmarkText(feature.landmark);
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

/** File and declaration hits take priority; this uses the same fitted drawing. */
export function hitNaturalFeature(
  features: NaturalFeatures,
  point: FeaturePoint,
  pixels: number,
  streams: boolean
): NaturalFeature | undefined {
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

function landmarkText(landmark: Landmark) {
  const { file, consumers, role, change } = landmark;
  const roles = {
    change: "Recorded change",
    commons: "Shared commons",
    dependents: "Dependency hub",
    junction: "Composition junction",
  };
  const served = consumers.length
    ? ` Drawn on by ${consumers.map((item) => item.label).join(", ")}.`
    : "";
  let detail = `${roles[role]} · ${file.incoming} incoming imports.${served}`;
  if (role === "dependents") {
    detail +=
      " At least 5 incoming imports and the 95th percentile or higher within this package.";
  }
  if (change) {
    const { history, file: changed } = change;
    const window = history.since
      ? `${history.since.slice(0, 10)}–${history.analyzedAt.slice(0, 10)}`
      : `full history through ${history.analyzedAt.slice(0, 10)}`;
    detail += ` ${changed.commits} commits · ${changed.linesChanged} lines added/deleted · ${Math.round(changed.rank.commitPercentile * 100)}th commit percentile among repository files of the same kind · ${window} · ${history.historyComplete ? "complete" : "partial"} Git history. Recorded change, never live activity or a quality verdict.`;
  }
  return { detail, title: file.path };
}
