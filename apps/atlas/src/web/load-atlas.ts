import { footprint, latitude } from "./codex/bindings";
import { resolveCodex } from "./codex/resolve";
import { readCodexSource } from "./codex/source";
import { viewerDataset } from "./dataset";
import { formerPackages } from "./former-packages";
import { landContours, settleFiles, settlePackages, unit } from "./geography";
import { settleLandmasses } from "./landmasses";
import { markLoad } from "./timings";
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
  markLoad("atlas:data-requested");
  const saved = await readCodexSource(viewerDataset({ signal }));
  markLoad("atlas:data-loaded");
  const codex = resolveCodex(saved);
  const edges = codex.imports;
  const territories: Territory[] = codex.packages.map((p) => {
    const files = codex.modules
      .filter((m) => m.package === p.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({
        directory: m.directory,
        highFanIn: m.highFanIn,
        id: m.id,
        incoming: m.dependents,
        internalFanIn: m.internalFanIn,
        kind: m.fileKind,
        outgoing: m.dependencies,
        path: m.path,
        x: 0,
        y: 0,
      }));
    const radius = footprint(p.size);
    settleFiles(files, radius, edges);
    const [shallows = [], coast = [], hills = []] = landContours(files, radius);
    return {
      analyzed: p.analyzed,
      coast,
      color:
        pigments[Math.floor(unit(`${p.id}:pigment`) * pigments.length)] ??
        "#efcf88",
      fileRoles: p.fileRoles,
      files,
      highFanInCutoff: p.highFanInCutoff,
      hills,
      id: p.id,
      label: p.label,
      radius,
      responsibilityGroups: p.responsibilityGroups,
      shallows,
      x: (unit(p.id) - 0.5) * 1400,
      y: latitude(p.layer),
    };
  });
  const routes = codex.dependencies.map((d) => ({
    consumerFiles: d.consumerFiles,
    from: d.from,
    sharedConcepts: d.sharedConcepts,
    supplierFiles: d.supplierFiles,
    to: d.to,
    weight: d.strength,
  }));
  const { declaredDependencies } = codex;
  settlePackages(
    territories,
    new Map(codex.packages.map((p) => [p.id, p.layer])),
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
    coverage: codex.workspace.coverage,
    declaredDependencies,
    fileEdges: edges.map(({ source, target }) => ({ source, target })),
    generatedAt: codex.workspace.surveyedAt,
    height,
    routes,
    territories,
    width,
  };
  if (codex.retiredPackages) {
    data.formerPackages = formerPackages(data, codex.retiredPackages);
  }
  markLoad("atlas:layout-settled");
  return data;
}
