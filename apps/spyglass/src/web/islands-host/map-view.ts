import type { SpyglassData } from "../data/types";
import type { SpyglassSelection } from "../interaction/selection";
import type { ChartSettings } from "../settings/chart-settings";
import type { InkView } from "../view/chart-view";
import type {
  CompositionNode,
  RenderStatus,
  SelectionRef,
} from "../view/map-contract";
import {
  DEFAULT_ISLANDS_SETTINGS,
  type Described,
  type Islands,
  type IslandsSettings,
  type IslandsStats,
  type IslandsView,
} from "./islands-api";
import { buildingSelection } from "./pick-identity";

/**
 * What the viewer's chrome, labels and panels read of an Islands map,
 * worked out from what the renderer's API gives: its camera (`view`),
 * `project`, `pixelsPerUnit` and `heightAt`. Pure, so it is tested without
 * a GPU.
 */

/** The fewest CSS pixels a chart unit is taken to span, so extents stay finite. */
const minimumPixelsPerUnit = 1e-6;

/** How many canvas sizes off its top left an unseen point is sent. */
const offCanvas = 4;

/** The camera's tilt off the vertical, radians, for an orbit's pitch above the horizon. */
export function tiltOf(view: Pick<IslandsView, "pitch">): number {
  return Math.max(0, Math.PI / 2 - view.pitch);
}

/** An orbit's pitch for the reader's camera elevation in degrees above the horizon. */
export function pitchOf(elevation: number): number {
  return (elevation * Math.PI) / 180;
}

/**
 * The view as the labels, the chrome and the margins read it (`InkView`):
 * the chart point at the centre of the canvas, the extent in chart units
 * the canvas covers there (its depth foreshortened by the tilt), the scale
 * Islands gives at its target, and the tilt. Exact at the centre only: a
 * perspective camera shows the far side smaller and the near side larger,
 * so it is read for scale (the labels' size and detail, the chrome's scale
 * bar and margins) and the canvas's size, never for what is on screen;
 * the labels decide that on screen, through `projectionOf`
 * (`label-candidates.ts` `LabelScreen`). The view is assumed north-up:
 * `InkView` has no turn, so a turned camera reads as unturned.
 */
export function inkViewOf(
  islands: Pick<Islands, "pixelsPerUnit" | "view">,
  size: { height: number; width: number }
): InkView {
  const { target } = islands.view;
  const tilt = tiltOf(islands.view);
  // Islands gives 0 only for a point behind the eye, which its target never is.
  const pixels = Math.max(minimumPixelsPerUnit, islands.pixelsPerUnit());
  return {
    height: size.height / (pixels * Math.cos(tilt)),
    pixelsPerUnit: pixels,
    tilt,
    width: size.width / pixels,
    x: target[0],
    y: target[2],
  };
}

/** The camera moved `factor` times closer (over 1) or further (under 1), as the app bar's zoom asks. */
export function zoomed(view: IslandsView, factor: number): IslandsView {
  return { ...view, distance: view.distance / Math.max(1e-6, factor) };
}

/**
 * What Islands chose, as the viewer's selection: an island is a territory
 * of the spyglass by the same id (the package id), and a module a file by
 * its id, on the territory that holds it; a building its package, and its
 * file when it holds one alone (`buildingSelection`). A ring has no
 * counterpart in the viewer and reads as none.
 */
export function selectionOf(
  described: Described | null,
  data: Pick<SpyglassData, "territories">
): SpyglassSelection | null {
  if (described?.kind === "island") {
    const territory = data.territories.find((item) => item.id === described.id);
    return territory ? { territory } : null;
  }
  if (described?.kind === "building") {
    return buildingSelection(described, data);
  }
  if (described?.kind === "module") {
    for (const territory of data.territories) {
      const file = territory.files.find((item) => item.id === described.id);
      if (file) {
        return { file, territory };
      }
    }
  }
  return null;
}

/** The chart id Islands chooses for the viewer's selection: the file's (a module), else its island's. */
export function selectedIdOf(selection: SelectionRef | null): string | null {
  return selection?.fileId ?? selection?.territoryId ?? null;
}

/**
 * Where a label or a chrome mark falls on the canvas: Islands' projection
 * of the chart point, raised onto the land under it (`heightAt`; on the
 * water, sea level). The height the labels' own model gives is the old
 * paper's and is not read. A point Islands cannot see (behind the eye) is
 * sent well off the canvas, where nothing is placed.
 */
export function projectionOf(
  islands: Pick<Islands, "heightAt" | "project">,
  size: () => { height: number; width: number }
): (x: number, y: number) => { x: number; y: number } {
  return (x, y) => {
    const point = islands.project(
      [x, y],
      Math.max(0, islands.heightAt([x, y]))
    );
    if (point.visible) {
      return { x: point.x, y: point.y };
    }
    const { height, width } = size();
    return { x: -offCanvas * width, y: -offCanvas * height };
  };
}

/**
 * The renderer's settings the viewer's own drive: the waves stop for
 * reduced motion and for the reader's "rim surf" off, so a still chart
 * submits no frames. Everything else stays at Islands' defaults.
 */
export function islandsSettingsOf(
  settings: Pick<ChartSettings, "waves">,
  reducedMotion: boolean
): Partial<IslandsSettings> {
  return {
    selection: true,
    waveAmplitude:
      settings.waves && !reducedMotion
        ? DEFAULT_ISLANDS_SETTINGS.waveAmplitude
        : 0,
  };
}

/** The Chart panel's readout from Islands' stats: always WebGPU, timed by its two GPU passes (null without timestamps). */
export function renderStatusOf(
  stats: IslandsStats | null,
  failure: string | null
): RenderStatus {
  const passes = [stats?.terrainMs, stats?.waterMs].filter(
    (ms): ms is number => typeof ms === "number"
  );
  return {
    adapted: false,
    backend: "webgpu",
    failure,
    frameMs: passes.length ? passes.reduce((sum, ms) => sum + ms, 0) : null,
    globalIlluminationAvailable: false,
    postProcessing: true,
    quality: "high",
  };
}

/**
 * The DEV Layers tab's composition from Islands' stats: the labels the
 * viewer letters over the canvas, each map Islands last rebuilt with the
 * main-thread milliseconds it took to encode, then the two GPU passes,
 * whose milliseconds are the GPU's, so they go in `counts`.
 */
export function compositionOf(
  stats: IslandsStats | null,
  labels: { counts: Record<string, number>; updateMs: number | null }
): CompositionNode[] {
  const maps = Object.entries(stats?.mapMs ?? {}).map(
    ([id, ms]): CompositionNode => ({
      counts: { texels: stats?.texels ?? 0 },
      enabled: true,
      id: `map:${id}`,
      kind: "layer",
      updateMs: ms ?? null,
    })
  );
  const pass = (
    id: string,
    ms: number | null | undefined
  ): CompositionNode => ({
    ...(typeof ms === "number" && { counts: { gpuMs: ms } }),
    enabled: true,
    id,
    kind: "stage",
    updateMs: null,
  });
  return [
    {
      counts: labels.counts,
      enabled: true,
      id: "labels",
      kind: "labels",
      updateMs: labels.updateMs,
    },
    ...maps,
    pass("terrain", stats?.terrainMs),
    pass("water", stats?.waterMs),
  ];
}
