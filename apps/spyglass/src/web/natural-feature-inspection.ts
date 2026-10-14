import type { Landmark } from "./landmarks";
import type { FeaturePoint, Marsh, NaturalFeatures } from "./natural-features";
import { percentileOrdinal } from "./natural-features";
import type { RiverRun } from "./river-network";
import type { SpyglassFile } from "./types";

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

/**
 * A file's import counts, leading with its internal fan-in against its
 * package's cutoff when it is high fan-in; the import edges are a different,
 * workspace-wide count.
 */
function importCounts(
  file: Pick<SpyglassFile, "highFanIn" | "incoming" | "internalFanIn">,
  cutoff: number
): string {
  // A high fan-in file is described by the measure that raised it; the
  // module graph's edge count measures something else and would read as a
  // contradiction beside it.
  return file.highFanIn
    ? `${file.internalFanIn} source modules of this package import it, at or above its high fan-in cutoff of ${cutoff}.`
    : `The module graph records ${file.incoming} import ${file.incoming === 1 ? "edge" : "edges"} ending here.`;
}

function landmarkText(landmark: Landmark) {
  const { basis, change, consumers, cutoff, file } = landmark;
  const labels = {
    change: "Recorded change",
    commons: "Shared commons",
    "high-fan-in": "High fan-in",
    junction: "Composition junction",
  };
  const served = consumers.length
    ? ` Drawn on by ${consumers.map((item) => item.label).join(", ")}.`
    : "";
  let detail = `${labels[basis]} · ${importCounts(file, cutoff)}${served}`;
  if (change) {
    const { file: changed, gate, history } = change;
    const window = history.since
      ? `${history.since.slice(0, 10)}–${history.analyzedAt.slice(0, 10)}`
      : `full history through ${history.analyzedAt.slice(0, 10)}`;
    detail += ` ${changed.commits} commits · ${changed.linesChanged} lines added/deleted · ${percentileOrdinal(changed.commitPercentile)} commit percentile among workspace files of the same kind, at or above the ${percentileOrdinal(gate.minCommitPercentile)} that frequent change requires · ${window} · ${history.historyComplete ? "complete" : "partial"} Git history. Recorded change, never live activity or a quality verdict.`;
  }
  return { detail, title: file.path };
}
