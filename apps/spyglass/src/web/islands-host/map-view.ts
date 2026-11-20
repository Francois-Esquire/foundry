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

const minimumPixelsPerUnit = 1e-6;

const offCanvas = 4;

export function tiltOf(view: Pick<IslandsView, "pitch">): number {
  return Math.max(0, Math.PI / 2 - view.pitch);
}

export function pitchOf(elevation: number): number {
  return (elevation * Math.PI) / 180;
}

export function inkViewOf(
  islands: Pick<Islands, "pixelsPerUnit" | "view">,
  size: { height: number; width: number }
): InkView {
  const { target } = islands.view;
  const tilt = tiltOf(islands.view);
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

export function zoomed(view: IslandsView, factor: number): IslandsView {
  return { ...view, distance: view.distance / Math.max(1e-6, factor) };
}

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

export function selectedIdOf(selection: SelectionRef | null): string | null {
  return selection?.fileId ?? selection?.territoryId ?? null;
}

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
