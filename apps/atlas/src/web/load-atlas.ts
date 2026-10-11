import { footprint } from "./codex/bindings";
import { placementKey, resolveCodex } from "./codex/resolve";
import { readCodexSource } from "./codex/source";
import { viewerDataset } from "./dataset";
import {
  districtsOfGroups,
  type FolderCell,
  settleFiles,
} from "./folder-sectors";
import { formerPackages } from "./former-packages";
import { chartSize, landContours, settlePackages } from "./geography";
import { defaultLandmassSettings } from "./landmasses";
import { markLoad } from "./timings";
import type { AtlasData, Territory } from "./types";

export async function loadAtlas(signal?: AbortSignal): Promise<AtlasData> {
  markLoad("atlas:data-requested");
  const saved = await readCodexSource(viewerDataset({ signal }));
  markLoad("atlas:data-loaded");
  const codex = resolveCodex(saved);
  const folderCells: Record<string, FolderCell> = {};
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
    // Without internals the island has no districts: its files go in path order.
    folderCells[p.id] = settleFiles(
      files,
      radius,
      p.path,
      p.responsibilityGroups && districtsOfGroups(p.responsibilityGroups.groups)
    );
    const [shallows = [], coast = [], hills = []] = landContours(files, radius);
    return {
      analyzed: p.analyzed,
      coast,
      fileRoles: p.fileRoles,
      files,
      folder: p.path,
      highFanInCutoff: p.highFanInCutoff,
      hills,
      id: p.id,
      label: p.label,
      radius,
      responsibilityGroups: p.responsibilityGroups,
      shallows,
      x: 0,
      y: 0,
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
  const packageLayers = Object.fromEntries(
    codex.packages.map((p) => [p.id, p.layer])
  );
  settlePackages(
    territories,
    packageLayers,
    defaultLandmassSettings.islandClearance
  );
  const data: AtlasData = {
    coverage: codex.workspace.coverage,
    declaredDependencies,
    domains: codex.domains,
    fileEdges: codex.imports.map(({ source, target }) => ({ source, target })),
    folderCells,
    generatedAt: codex.workspace.surveyedAt,
    nesting: codex.nesting,
    packageLayers,
    placement: {
      dominantShare: codex.placement.dominantShare,
      labelled: codex.placement.labelled,
      places: Object.fromEntries(
        codex.placement.places.map((place) => [placementKey(place), place])
      ),
    },
    proximity: codex.proximity,
    routes,
    territories,
    ...chartSize(territories),
  };
  if (codex.retiredPackages) {
    data.formerPackages = formerPackages(data, codex.retiredPackages);
  }
  markLoad("atlas:layout-settled");
  return data;
}
