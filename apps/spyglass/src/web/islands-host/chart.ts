import type { DatasetReader } from "../../lib/dataset";
import type { SemanticsModuleIndex } from "../../lib/semantics-types";
import type { PreparedVisualization } from "../../lib/visualization/types";
import { pinnedRead, viewerDataset } from "../data/dataset";
import type { DatasetRef, SpyglassData } from "../data/types";
import { type Chart, chartFromDataset } from "./islands-api";

/** The dataset reads the Islands chart is made from. */
type ChartReader = Pick<
  DatasetReader,
  | "dependencyGraph"
  | "lens"
  | "moduleEdgeShards"
  | "moduleIndex"
  | "moduleShards"
>;

/**
 * What `chartFromDataset(map, graph, internals)` is handed: the dataset's
 * own files, in the shapes the prototype's capture script copies them in
 * for its fixtures, plus why anything optional was left out.
 */
export interface IslandsChartInputs {
  graph: unknown;
  internals: {
    edges: unknown;
    /** The lens, or undefined when the dataset has none it can read. */
    frequentChange: unknown;
    modules: unknown;
    responsibilityGroups: unknown;
    shards: unknown;
  };
  map: PreparedVisualization;
  /** One line per input left out, for the developer panel beside the chart's own notes. */
  notes: string[];
}

/**
 * Each file's place on its island as the viewer laid it out, by id: the
 * dataset's `mapPosition`, or for a dataset that saved none, the place the
 * viewer worked out (`placeFiles`).
 */
export type FilePlaces = ReadonlyMap<string, { x: number; y: number }>;

/** The viewer's file places, from its territories. */
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

/**
 * The module index with every module the dataset saved no place for placed
 * where the viewer laid it out, so the chart draws the files the labels name.
 */
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

/** A lens the adapter can do without: undefined, with a note, when the dataset cannot give it. */
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

/**
 * Reads what the chart is made from, all at once. `map` is the map the
 * viewer laid its territories out from (the frame's `visualization`), so
 * the chart shares coordinates with the labels and the chrome, which read
 * `SpyglassData`; `places`, the viewer's file places, fill in any the
 * dataset did not save.
 */
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

/** The chart for a dataset the viewer was served with, and every note on what it left out. */
export async function loadIslandsChart({
  dataset,
  places,
  signal,
  visualization,
}: {
  dataset?: DatasetRef;
  /** The viewer's file places (`filePlacesOf`), for a dataset that saved none. */
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
