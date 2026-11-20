import type { DatasetReader } from "../../lib/dataset";
import type { SemanticsModuleIndex } from "../../lib/semantics-types";
import type { PreparedVisualization } from "../../lib/visualization/types";
import { pinnedRead, viewerDataset } from "../data/dataset";
import type { DatasetRef, SpyglassData } from "../data/types";
import { type Chart, chartFromDataset } from "./islands-api";

type ChartReader = Pick<
  DatasetReader,
  | "dependencyGraph"
  | "lens"
  | "moduleEdgeShards"
  | "moduleIndex"
  | "moduleShards"
>;

export interface IslandsChartInputs {
  graph: unknown;
  internals: {
    edges: unknown;
    frequentChange: unknown;
    modules: unknown;
    responsibilityGroups: unknown;
    shards: unknown;
  };
  map: PreparedVisualization;
  notes: string[];
}

export type FilePlaces = ReadonlyMap<string, { x: number; y: number }>;

export function filePlacesOf(
  data: Pick<SpyglassData, "territories">
): FilePlaces {
  const places = new Map<string, { x: number; y: number }>();
  for (const territory of data.territories) {
    for (const file of territory.files) {
      places.set(file.id, { x: file.x, y: file.y });
    }
  }
  return places;
}

function placedModules(
  index: SemanticsModuleIndex,
  places: FilePlaces | undefined,
  notes: string[]
): SemanticsModuleIndex {
  if (!places) {
    return index;
  }
  let filled = 0;
  const modules = index.modules.map((module) => {
    const place = places.get(module.id);
    if (module.mapPosition || !place) {
      return module;
    }
    filled += 1;
    return { ...module, mapPosition: place };
  });
  if (filled === 0) {
    return index;
  }
  notes.push(
    `modules: ${filled} without a saved place placed as the viewer laid them out`
  );
  return { ...index, modules };
}

async function optionalLens(
  reader: ChartReader,
  id: "frequent-change" | "responsibility-groups",
  notes: string[]
): Promise<unknown> {
  try {
    return await reader.lens(id);
  } catch (error) {
    notes.push(
      `${id}: left out (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

export async function readIslandsChartInputs(
  reader: ChartReader,
  map: PreparedVisualization,
  places?: FilePlaces
): Promise<IslandsChartInputs> {
  const notes: string[] = [];
  const [graph, modules, shards, edges, responsibilityGroups, frequentChange] =
    await Promise.all([
      reader.dependencyGraph(),
      reader.moduleIndex(),
      reader.moduleShards(),
      reader.moduleEdgeShards(),
      optionalLens(reader, "responsibility-groups", notes),
      optionalLens(reader, "frequent-change", notes),
    ]);
  return {
    graph,
    internals: {
      edges,
      frequentChange,
      modules: placedModules(modules, places, notes),
      responsibilityGroups,
      shards,
    },
    map,
    notes,
  };
}

export async function loadIslandsChart({
  dataset,
  places,
  signal,
  visualization,
}: {
  dataset?: DatasetRef;
  places?: FilePlaces;
  signal?: AbortSignal;
  visualization: PreparedVisualization;
}): Promise<{ chart: Chart; notes: string[] }> {
  const reader = viewerDataset({ dataset, signal });
  const inputs = await pinnedRead(() =>
    readIslandsChartInputs(reader, visualization, places)
  );
  const chart = chartFromDataset(inputs.map, inputs.graph, inputs.internals);
  return { chart, notes: [...inputs.notes, ...chart.source.notes] };
}
