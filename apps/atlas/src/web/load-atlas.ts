import type {
  SemanticsManifest,
  SemanticsModuleEdgeShard,
  SemanticsModuleIndex,
  SemanticsModuleShard,
} from "../lib/semantics-types";
import type { WorkspaceGraphProjection } from "../lib/workspace-projection-types";
import { formerPackages } from "./former-packages";
import { landContours, settleFiles, settlePackages, unit } from "./geography";
import { settleLandmasses } from "./landmasses";
import { findNeighborhoods } from "./neighborhoods";
import { fileRelationships } from "./relationships";
import type { AtlasData, Territory } from "./types";

const pigments = [
  "#efcf88",
  "#b4d5a5",
  "#edb59d",
  "#a3d6bc",
  "#ead6a5",
  "#cab6df",
  "#d6dda0",
];

export async function loadAtlas(signal?: AbortSignal): Promise<AtlasData> {
  const read = async <T>(file: string): Promise<T> => {
    const response = await fetch(`/data/${file}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Could not load ${file} (${response.status}). Run atlas scan to generate the dataset.`
      );
    }
    return (await response.json()) as T;
  };
  const manifest = await read<SemanticsManifest>("manifest.json");
  if (manifest.schemaVersion !== 3) {
    throw new Error(
      `Unsupported semantics dataset version ${manifest.schemaVersion}.`
    );
  }
  const [index, graph] = await Promise.all([
    read<SemanticsModuleIndex>(manifest.files.moduleIndex),
    read<WorkspaceGraphProjection>(manifest.files.projections.dependencyGraph),
  ]);
  const edges = (
    await Promise.all(
      index.edgeShards.map((s) => read<SemanticsModuleEdgeShard>(s.file))
    )
  ).flatMap((s) => s.edges);
  const moduleShards = await Promise.all(
    index.shards.map((s) => read<SemanticsModuleShard>(s.file))
  );
  const participation = new Map(
    moduleShards.flatMap((s) =>
      s.modules.map(
        (m) => [m.id, [...new Set(Object.values(m.concepts).flat())]] as const
      )
    )
  );
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }
  const territories: Territory[] = [...graph.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => {
      const files = index.modules
        .filter((m) => m.package === p.id)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((m) => ({
          directory: m.path.slice(0, m.path.lastIndexOf("/")),
          id: m.id,
          incoming: incoming.get(m.id) ?? 0,
          kind: m.fileKind ?? "unknown",
          outgoing: outgoing.get(m.id) ?? 0,
          path: m.path,
          x: 0,
          y: 0,
        }));
      const radius = 28 + 5.8 * Math.sqrt(files.length);
      const relationships = fileRelationships(
        files.map((f) => f.id),
        edges,
        participation
      );
      const neighborhoods = findNeighborhoods(files, relationships);
      settleFiles(files, radius, edges);
      const [shallows = [], coast = [], hills = []] = landContours(
        files,
        radius
      );
      return {
        analyzed: p.analyzed,
        coast,
        color:
          pigments[Math.floor(unit(`${p.id}:pigment`) * pigments.length)] ??
          "#efcf88",
        files,
        hills,
        id: p.id,
        label: p.label,
        neighborhoods,
        radius,
        shallows,
        x: (unit(p.id) - 0.5) * 1400,
        y: -(p.layer ?? 0) * 220,
      };
    });
  const routes = graph.edges.flatMap((e) =>
    e.kind === "dependency"
      ? [
          {
            from: e.from,
            sharedConcepts: e.concepts.total,
            to: e.to,
            weight: e.dependency.moduleEdges,
          },
        ]
      : []
  );
  const packageIds = new Set(territories.map((p) => p.id));
  const declaredDependencies = (
    await Promise.all(
      manifest.packages.map(async (p) => {
        const name = encodeURIComponent(p.id.replaceAll("/", "__"));
        const contents = await read<
          Partial<
            Record<
              | "dependencies"
              | "devDependencies"
              | "peerDependencies"
              | "optionalDependencies",
              Record<string, string>
            >
          >
        >(`manifests/${name}.json`);
        return (
          [
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
          ] as const
        ).flatMap((kind) =>
          Object.keys(contents[kind] ?? {})
            .filter((to) => packageIds.has(to) && to !== p.id)
            .map((to) => ({ from: p.id, kind, to }))
        );
      })
    )
  ).flat();
  settlePackages(
    territories,
    new Map(graph.nodes.map((p) => [p.id, p.layer ?? 0])),
    routes
  );
  settleLandmasses(territories, routes, declaredDependencies);
  const width =
    2 *
    (Math.max(0, ...territories.map((p) => Math.abs(p.x) + p.radius)) + 120);
  const height =
    2 *
    (Math.max(0, ...territories.map((p) => Math.abs(p.y) + p.radius)) + 120);
  const data: AtlasData = {
    coverage: manifest.coverage,
    declaredDependencies,
    fileEdges: edges.map(({ source, target }) => ({ source, target })),
    generatedAt: manifest.generatedAt,
    height,
    routes,
    territories,
    width,
  };
  const historyManifest = await fetch("/data/history/manifest.json", {
    cache: "no-store",
    signal,
  });
  if (historyManifest.ok) {
    const historyEntities = await read<Parameters<typeof formerPackages>[2]>(
      "history/entities.json"
    );
    data.formerPackages = formerPackages(
      data,
      (await historyManifest.json()) as Parameters<typeof formerPackages>[1],
      historyEntities
    );
  } else if (historyManifest.status !== 404) {
    throw new Error(`Could not load history (${historyManifest.status}).`);
  }
  return data;
}
