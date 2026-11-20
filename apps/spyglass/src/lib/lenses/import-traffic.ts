import { byCodeUnit } from "@foundry/lib/ordering";
import type {
  SemanticsModuleEdge,
  SemanticsModuleIndexEntry,
} from "../semantics-types";
import type { ImportTraffic, ImportTrafficPair } from "./import-traffic-types";
import { IMPORT_TRAFFIC_SCHEMA_VERSION } from "./import-traffic-types";
import type { Lens } from "./lens-types";

export interface ImportTrafficSource {
  edges: Pick<SemanticsModuleEdge, "source" | "target">[];
  modules: Pick<SemanticsModuleIndexEntry, "id" | "package">[];
}

const byText = byCodeUnit((text: string) => text);

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
