import type { SpyglassData, SpyglassFile, Territory } from "../data/types";
import type { InkView } from "../view/chart-view";

export function fileConnections(data: SpyglassData, id: string) {
  const destinations = new Map<
    string,
    { territory: Territory; file: SpyglassFile }
  >();
  for (const territory of data.territories) {
    for (const file of territory.files) {
      destinations.set(file.id, { file, territory });
    }
  }
  const seen = new Set<string>();
  return data.fileEdges
    .flatMap((edge) => {
      let direction: "Imports" | "Imported by" | null;
      if (edge.source === id) {
        direction = "Imports";
      } else if (edge.target === id) {
        direction = "Imported by";
      } else {
        direction = null;
      }
      if (!direction) {
        return [];
      }
      const other = edge.source === id ? edge.target : edge.source;
      const destination = destinations.get(other);
      const key = `${direction}:${other}`;
      if (!destination || seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [{ ...destination, direction }];
    })
    .sort(
      (a, b) =>
        a.direction.localeCompare(b.direction) ||
        a.file.path.localeCompare(b.file.path)
    );
}

export function visibleRegionTerritory(
  territories: Territory[],
  view: InkView
): Territory | undefined {
  if (view.pixelsPerUnit < 1.2) {
    return undefined;
  }
  let nearest: Territory | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const territory of territories) {
    const next = Math.hypot(territory.x - view.x, territory.y - view.y);
    if (next < territory.radius * 1.5 && next < distance) {
      nearest = territory;
      distance = next;
    }
  }
  return nearest;
}

export interface MapLabel {
  /** Small capitals printed beneath the name, e.g. a package's file count. */
  caption?: string;
  compositeId?: string;
  /** The chosen domain's name, in the domain's ink. */
  domain?: boolean;
  file?: SpyglassFile;
  /** A folder's name, set in italics in the folder ink. */
  folder?: boolean;
  font: string;
  /** The frame whose label this is, by id: a workspace's label above its frame, in spaced capitals. It has no island. */
  frame?: string;
  height: number;
  opacity?: number;
  regionId?: string;
  /** The island the label names or sits on; none for a frame's label. */
  territory?: Territory;
  text: string;
  width: number;
  x: number;
  y: number;
}

/**
 * The placed label under a point on the chart, which a click selects. The
 * domain's name and a frame's label are captions, not places, so a click
 * passes through them.
 */
export function labelUnder(
  labels: readonly MapLabel[],
  x: number,
  y: number
): MapLabel | undefined {
  return labels.find(
    (label) =>
      !label.domain &&
      label.frame === undefined &&
      Math.abs(x - label.x) < label.width / 2 &&
      y >= label.y - label.height &&
      y <= label.y
  );
}

export function visibleLabels(
  candidates: MapLabel[],
  view: InkView
): MapLabel[] {
  const placed: MapLabel[] = [];
  const gap = (view.width < view.height ? 10 : 5) / view.pixelsPerUnit;
  for (const label of candidates) {
    if (
      label.x - label.width / 2 < view.x - view.width / 2 + gap ||
      label.x + label.width / 2 > view.x + view.width / 2 - gap ||
      label.y - label.height < view.y - view.height / 2 + gap ||
      label.y > view.y + view.height / 2 - gap
    ) {
      continue;
    }
    if (
      placed.some(
        (p) =>
          Math.abs(p.x - label.x) < (p.width + label.width) / 2 + gap &&
          label.y + gap > p.y - p.height &&
          label.y - label.height < p.y + gap
      )
    ) {
      continue;
    }
    placed.push(label);
  }
  return placed;
}
