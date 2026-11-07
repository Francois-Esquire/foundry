import type { DatasetReader } from "../../lib/dataset";
import type { PreparedVisualization } from "../../lib/visualization/types";
import { pinnedRead, viewerDataset } from "../data/dataset";
import type { DatasetRef } from "../data/types";
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
 * `SpyglassData`.
 */
export async function readIslandsChartInputs(
  reader: ChartReader,
  map: PreparedVisualization
): Promise<IslandsChartInputs> {
  const notes: string[] = [];
  const [graph, modules, shards, edges, responsibilityGroups, frequentChange] =
    await Promise.all([
      reader.dependencyGraph(),
      reader.moduleIndex(),
      // New weight at load: the old viewer read no module shard until an
      // island's internals were asked for. They carry each file's history.
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
      modules,
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
  signal,
  visualization,
}: {
  dataset?: DatasetRef;
  signal?: AbortSignal;
  visualization: PreparedVisualization;
}): Promise<{ chart: Chart; notes: string[] }> {
  const reader = viewerDataset({ dataset, signal });
  const inputs = await pinnedRead(() =>
    readIslandsChartInputs(reader, visualization)
  );
  const chart = chartFromDataset(inputs.map, inputs.graph, inputs.internals);
  return { chart, notes: [...inputs.notes, ...chart.source.notes] };
}
