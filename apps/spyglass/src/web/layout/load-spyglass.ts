import { DatasetNotFoundError } from "../../lib/dataset";
import { placeFiles } from "../../lib/file-placement";
import { footprint, latitude } from "../data/bindings";
import {
  pinnedRead,
  readCollectionManifest,
  viewerDataset,
} from "../data/dataset";
import { placementKey, resolveCodex, resolveLateCodex } from "../data/resolve";
import {
  type CodexSource,
  readCodexSource,
  readLateCodexSource,
} from "../data/source";
import type { FolderCell } from "../data/types";
import {
  type DatasetRef,
  qualifySpyglassData,
  type SpyglassData,
  type Territory,
} from "../data/types";
import type { LateCodex } from "../data/vocabulary";
import { defaultLandmassSettings } from "../settings/landmass-settings";
import { markLoad } from "../timings";
import { composeCollection } from "./collection";
import { clusterFolders } from "./folder-sectors";
import { formerPackages } from "./former-packages";
import { deriveFoundations, positionFoundations } from "./foundations";
import { chartSize, landContours, settlePackages, unit } from "./geography";

/**
 * The readings a spyglass holds until `loadLateReadings` brings them: no
 * folder tree, path region or seam, and no package the proximity lens
 * covered, so Place says nothing of either rather than "none".
 */
const unreadReadings: LateCodex = {
  nesting: { folders: [], pathRegions: [], seams: [] },
  proximity: { apart: { coChanges: [], files: [] }, close: [], labelled: [] },
};

/**
 * Fails when a later scan has replaced a frame's dataset: the manifest,
 * read again after a late read, must still be the one the layout read. A
 * pinned reader checks the manifest before it reads; this catches a scan
 * that published while the files were being read.
 */
async function stillTheSameDataset(
  dataset: DatasetRef,
  signal?: AbortSignal
): Promise<void> {
  await viewerDataset({ dataset, signal }).manifest();
}

/** The late readings of each frame, by frame id. */
export type LateReadings = Readonly<Record<string, LateCodex>>;

/**
 * The readings nothing at overview draws, read after the layout so that the
 * first one does not wait for them: the `nesting` and `proximity` lenses,
 * for each frame from its own dataset. Pinned to it, and checked against it
 * again once read, so a later scan is refused rather than mixed in. Each
 * frame takes them as they are (`FrameReadings` fields of the same names).
 */
export async function loadLateReadings(
  spyglass: Pick<SpyglassData, "frames">,
  signal?: AbortSignal
): Promise<LateReadings> {
  const late = await Promise.all(
    spyglass.frames.map(({ dataset, id }) =>
      pinnedRead(async () => {
        const read = resolveLateCodex(
          await readLateCodexSource(viewerDataset({ dataset, signal }))
        );
        await stillTheSameDataset(dataset, signal);
        return [id, read] as const;
      })
    )
  );
  markLoad("spyglass:readings-loaded");
  return Object.fromEntries(late);
}

/**
 * Every import edge, for Trace imports: all of each frame's edge shards at
 * once, since the files that import a file can sit in any package's shard.
 * Read only when a trace asks, pinned and checked as `loadLateReadings` is.
 */
export async function loadImports(
  spyglass: Pick<SpyglassData, "frames">,
  signal?: AbortSignal
): Promise<SpyglassData["fileEdges"]> {
  const frames = await Promise.all(
    spyglass.frames.map(({ dataset, id }) =>
      pinnedRead(async () => {
        const read = await viewerDataset({
          dataset,
          signal,
        }).moduleEdgeShards();
        await stillTheSameDataset(dataset, signal);
        // Qualified as the frame's files are (`qualifySpyglassData`).
        const file = (path: string) => (id ? `${id}:${path}` : path);
        return read.flatMap((shard) =>
          shard.edges.map(({ source, target }) => ({
            source: file(source),
            target: file(target),
          }))
        );
      })
    )
  );
  return frames.flat();
}

/** The dataset at the data root, as a single workspace's server or export gives it. */
const atDataRoot = (generatedAt: string): DatasetRef => ({
  generatedAt,
  root: "",
});

/**
 * The spyglass the viewer was served with. A single workspace's dataset at the
 * data root is read first; where the data root holds no `manifest.json`, a
 * collection's manifest is (5.3: only on `DatasetNotFoundError`, never on a
 * parse error or a server's failure), and each workspace's dataset is read
 * on a reader pinned to the `generatedAt` the manifest gives it, laid out
 * with its bare ids, qualified, and set beside the others. `onWait` hears
 * the server's reason while a collection's workspace is being swapped.
 */
export async function loadSpyglass(
  signal?: AbortSignal,
  onWait?: (reason: string) => void
): Promise<SpyglassData> {
  markLoad("spyglass:data-requested");
  const single = await readCodexSource(viewerDataset({ signal })).catch(
    (error: unknown) => {
      if (error instanceof DatasetNotFoundError) {
        return;
      }
      throw error;
    }
  );
  if (single) {
    markLoad("spyglass:data-loaded");
    const data = layoutWorkspace(
      single,
      atDataRoot(single.dataset.generatedAt)
    );
    markLoad("spyglass:layout-settled");
    return data;
  }
  const manifest = await readCollectionManifest({ onWait, signal });
  const saved = await Promise.all(
    manifest.workspaces.map(async (workspace) => {
      const dataset: DatasetRef = {
        generatedAt: workspace.generatedAt,
        root: workspace.dataset,
      };
      const source = await pinnedRead(() =>
        readCodexSource(viewerDataset({ dataset, signal }))
      ).catch((error: unknown) => {
        throw workspaceError(workspace.label, error);
      });
      return { dataset, source, workspace };
    })
  );
  markLoad("spyglass:data-loaded");
  const data = composeCollection(
    saved.map(({ dataset, source, workspace }) =>
      qualifySpyglassData(layoutWorkspace(source, dataset), workspace)
    ),
    manifest.crossings
  );
  markLoad("spyglass:layout-settled");
  return data;
}

/**
 * A collection workspace's failure, named by its label: a dataset the
 * collection manifest lists but the server no longer has is being saved
 * (caught mid-swap); anything else, as it is, after the label.
 */
function workspaceError(label: string, error: unknown): Error {
  if (error instanceof DatasetNotFoundError) {
    return new Error(`Workspace ${label} is being saved; reload in a moment.`, {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Workspace ${label}: ${message}`, { cause: error });
}

/** One workspace's spyglass from its saved source, laid out with its bare ids, as one frame. */
function layoutWorkspace(
  saved: CodexSource,
  dataset: DatasetRef
): SpyglassData {
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
        x: m.mapPosition?.x ?? 0,
        y: m.mapPosition?.y ?? 0,
      }));
    const radius = footprint(p.size);
    if (
      saved.modules.some(
        (module) => module.package === p.id && module.mapPosition === undefined
      )
    ) {
      placeFiles(files, radius, saved.layoutEdges ?? []);
    }
    folderCells[p.id] = clusterFolders(files, p.path);
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
      x: (unit(p.id) - 0.5) * 1400,
      y: latitude(p.layer ?? 0),
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
  const foundations = saved.dependencyInventory
    ? deriveFoundations(
        saved.dependencyInventory,
        territories.map(({ id }) => id)
      )
    : [];
  const packageLayers = Object.fromEntries(
    codex.packages.map((p) => [p.id, p.layer])
  );
  settlePackages(
    territories,
    packageLayers,
    defaultLandmassSettings.islandClearance,
    routes,
    foundations,
    defaultLandmassSettings.foundationInfluence
  );
  const data: SpyglassData = {
    coverage: codex.workspace.coverage,
    declaredDependencies,
    dependencyCoverage:
      saved.dependencyInventory?.graph?.resolution.status ?? "unavailable",
    // Read on Trace imports (`loadImports`); no edge shard is read at load.
    fileEdges: [],
    folderCells,
    foundationInfluence: defaultLandmassSettings.foundationInfluence,
    foundations: positionFoundations(foundations, territories),
    frames: [
      {
        dataset,
        id: "",
        label: "",
        readings: {
          domains: codex.domains,
          nesting: unreadReadings.nesting,
          placement: {
            dominantShare: codex.placement.dominantShare,
            labelled: codex.placement.labelled,
            places: Object.fromEntries(
              codex.placement.places.map((place) => [
                placementKey(place),
                place,
              ])
            ),
          },
          proximity: unreadReadings.proximity,
        },
        territories: territories.map((territory) => territory.id),
      },
    ],
    packageLayers,
    routes,
    territories,
    ...chartSize(territories),
  };
  if (codex.retiredPackages) {
    data.formerPackages = formerPackages(data, codex.retiredPackages);
  }
  return data;
}
