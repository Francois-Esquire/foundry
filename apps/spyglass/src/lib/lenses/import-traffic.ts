import { byCodeUnit } from "@foundry/lib/ordering";
import type {
  SemanticsModuleEdge,
  SemanticsModuleIndexEntry,
} from "../semantics-types";
import type { ImportTraffic, ImportTrafficPair } from "./import-traffic-types";
import { IMPORT_TRAFFIC_SCHEMA_VERSION } from "./import-traffic-types";
import type { Lens } from "./lens-types";

/** Every dataset field the lens reads. */
export interface ImportTrafficSource {
  edges: Pick<SemanticsModuleEdge, "source" | "target">[];
  modules: Pick<SemanticsModuleIndexEntry, "id" | "package">[];
}

const byText = byCodeUnit((text: string) => text);

/**
 * Each ordered package pair's endpoint files, from the import edges that
 * cross from one package into another, in one pass over the edges. An edge
 * with an end in no package of the index, or within one package, is left
 * out.
 */
export function importPairs(
  edges: readonly Pick<SemanticsModuleEdge, "source" | "target">[],
  packageOf: ReadonlyMap<string, string>
): ImportTrafficPair[] {
  const pairs = new Map<
    string,
    { from: string; sources: Set<string>; targets: Set<string>; to: string }
  >();
  for (const edge of edges) {
    const from = packageOf.get(edge.source);
    const to = packageOf.get(edge.target);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    const key = JSON.stringify([from, to]);
    let pair = pairs.get(key);
    if (pair === undefined) {
      pair = { from, sources: new Set(), targets: new Set(), to };
      pairs.set(key, pair);
    }
    pair.sources.add(edge.source);
    pair.targets.add(edge.target);
  }
  return [...pairs.values()]
    .sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to))
    .map(({ from, sources, targets, to }) => ({
      consumerFiles: [...sources].sort(byText),
      from,
      supplierFiles: [...targets].sort(byText),
      to,
    }));
}

/**
 * Where packages import from one another, file by file: for each ordered
 * pair the module edges cross, the files at each end. It reads the module
 * index, for each file's package, and every edge shard once, at scan time,
 * so that a reader of the pairs reads no shard.
 */
export const importTrafficLens: Lens<"import-traffic", ImportTrafficSource> = {
  derive: ({ edges, modules }): ImportTraffic => ({
    pairs: importPairs(
      edges,
      new Map(modules.map((module) => [module.id, module.package]))
    ),
  }),
  id: "import-traffic",
  read: async (reader) => {
    const [index, shards] = await Promise.all([
      reader.moduleIndex(),
      reader.moduleEdgeShards(),
    ]);
    return {
      edges: shards.flatMap((shard) =>
        shard.edges.map(({ source, target }) => ({ source, target }))
      ),
      modules: index.modules.map(({ id, package: pkg }) => ({
        id,
        package: pkg,
      })),
    };
  },
  schemaVersion: IMPORT_TRAFFIC_SCHEMA_VERSION,
  settings: [],
};
