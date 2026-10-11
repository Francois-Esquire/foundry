import { footprint } from "./codex/bindings";
import { placementKey, resolveCodex, resolveLateCodex } from "./codex/resolve";
import { readCodexSource, readLateCodexSource } from "./codex/source";
import type { LateCodex } from "./codex/vocabulary";
import { pinnedRead, viewerDataset } from "./dataset";
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

/**
 * The readings an atlas holds until `loadLateReadings` brings them: no
 * folder tree, path region or seam, and no package the proximity lens
 * covered, so Place says nothing of either rather than "none".
 */
const unreadReadings: LateCodex = {
  nesting: { folders: [], pathRegions: [], seams: [] },
  proximity: { apart: { coChanges: [], files: [] }, close: [], labelled: [] },
};

/**
 * Fails when a later scan has replaced the atlas's dataset: the manifest,
 * read again after a late read, must still be the one the layout read. A
 * pinned reader checks the manifest before it reads; this catches a scan
 * that published while the files were being read.
 */
async function stillTheSameDataset(
  atlas: Pick<AtlasData, "generatedAt">,
  signal?: AbortSignal
): Promise<void> {
  await viewerDataset({ pin: atlas.generatedAt, signal }).manifest();
}

/**
 * The readings nothing at overview draws, read after the layout so that the
 * first one does not wait for them: the `nesting` and `proximity` lenses.
 * Pinned to the atlas's dataset, and checked against it again once read,
 * so a later scan is refused rather than mixed in. The atlas takes them as
 * they are (`AtlasData` fields of the same names).
 */
export async function loadLateReadings(
  atlas: Pick<AtlasData, "generatedAt">,
  signal?: AbortSignal
): Promise<LateCodex> {
  const late = await pinnedRead(async () => {
    const read = resolveLateCodex(
      await readLateCodexSource(
        viewerDataset({ pin: atlas.generatedAt, signal })
      )
    );
    await stillTheSameDataset(atlas, signal);
    return read;
  });
  markLoad("atlas:readings-loaded");
  return late;
}

/**
 * Every import edge, for Trace imports: all of the edge shards at once,
 * since the files that import a file can sit in any package's shard. Read
 * only when a trace asks, pinned and checked as `loadLateReadings` is.
 */
export async function loadImports(
  atlas: Pick<AtlasData, "generatedAt">,
  signal?: AbortSignal
): Promise<AtlasData["fileEdges"]> {
  const shards = await pinnedRead(async () => {
    const read = await viewerDataset({
      pin: atlas.generatedAt,
      signal,
    }).moduleEdgeShards();
    await stillTheSameDataset(atlas, signal);
    return read;
  });
  return shards.flatMap((shard) =>
    shard.edges.map(({ source, target }) => ({ source, target }))
  );
}

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
    // Read on Trace imports (`loadImports`); no edge shard is read at load.
    fileEdges: [],
    folderCells,
    generatedAt: codex.workspace.surveyedAt,
    nesting: unreadReadings.nesting,
    packageLayers,
    placement: {
      dominantShare: codex.placement.dominantShare,
      labelled: codex.placement.labelled,
      places: Object.fromEntries(
        codex.placement.places.map((place) => [placementKey(place), place])
      ),
    },
    proximity: unreadReadings.proximity,
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
