import { DatasetNotFoundError } from "../../lib/dataset";
import { placeFiles } from "../../lib/file-placement";
import { prepareVisualization } from "../../lib/visualization/prepare";
import { ownDependencies } from "../../lib/visualization/sea-stacks";
import { footprint } from "../data/bindings";
import { pinnedRead, servesCollection, viewerDataset } from "../data/dataset";
import { placementKey, resolveCodex, resolveLateCodex } from "../data/resolve";
import {
  type CodexSource,
  readCodexSource,
  readLateCodexSource,
} from "../data/source";
import type { DatasetRef, SpyglassData, Territory } from "../data/types";
import type { LateCodex } from "../data/vocabulary";
import { markLoad } from "../timings";

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

/** Why a collection's data root cannot be drawn. */
export const COLLECTION_UNSUPPORTED =
  "This spyglass serves a collection of workspaces; the map draws one workspace at a time. Open each workspace on its own.";

/**
 * The spyglass the viewer was served with: a single workspace's dataset at
 * the data root, laid out as one frame. Where the data root holds no
 * `manifest.json` (only on `DatasetNotFoundError`, never on a parse error
 * or a server's failure) but serves a collection (5.3), the load fails
 * with `COLLECTION_UNSUPPORTED` without reading the collection: the Islands
 * chart is made from one workspace's map. With neither, it fails as not
 * found.
 */
export async function loadSpyglass(
  signal?: AbortSignal
): Promise<SpyglassData> {
  markLoad("spyglass:data-requested");
  let single: CodexSource;
  try {
    single = await readCodexSource(viewerDataset({ signal }));
  } catch (error) {
    if (
      error instanceof DatasetNotFoundError &&
      (await servesCollection(signal))
    ) {
      throw new Error(COLLECTION_UNSUPPORTED, { cause: error });
    }
    throw error;
  }
  markLoad("spyglass:data-loaded");
  const data = layoutWorkspace(single, atDataRoot(single.dataset.generatedAt));
  markLoad("spyglass:layout-settled");
  return data;
}

/** One workspace's spyglass from its saved source, laid out with its bare ids, as one frame. */
function layoutWorkspace(
  saved: CodexSource,
  dataset: DatasetRef
): SpyglassData {
  const codex = resolveCodex(saved);
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
    return {
      analyzed: p.analyzed,
      coast: [],
      fileRoles: p.fileRoles,
      files,
      folder: p.path,
      highFanInCutoff: p.highFanInCutoff,
      hills: [],
      id: p.id,
      label: p.label,
      radius,
      responsibilityGroups: p.responsibilityGroups,
      shallows: [],
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
  const prepared = prepareVisualization(
    {
      inventory: saved.dependencyInventory,
      modules: territories.flatMap((territory) =>
        territory.files.map(({ id, x, y }) => ({
          id,
          package: territory.id,
          x,
          y,
        }))
      ),
      packages: codex.packages.map(({ id, layer, size }) => ({
        id,
        layer,
        size,
      })),
      routes: routes.map(({ from, to, weight }) => ({ from, to, weight })),
    },
    undefined,
    saved.visualization
  );
  const geometry = new Map(
    prepared.islands.map((island) => [island.id, island])
  );
  for (const territory of territories) {
    Object.assign(territory, geometry.get(territory.id));
  }
  const data: SpyglassData = {
    coverage: codex.workspace.coverage,
    declaredDependencies,
    dependencyCoverage:
      saved.dependencyInventory?.graph?.resolution.status ?? "unavailable",
    // Read on Trace imports (`loadImports`); no edge shard is read at load.
    fileEdges: [],
    foundationGroups: prepared.groups,
    foundations: prepared.foundations,
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
        visualization: prepared,
      },
    ],
    height: prepared.height,
    internalFoundations: prepared.internalFoundations,
    ...(saved.dependencyInventory && {
      ownDependencies: ownDependencies(
        saved.dependencyInventory,
        territories.map(({ id }) => id)
      ),
    }),
    packageLayers,
    routes,
    territories,
    width: prepared.width,
  };
  return data;
}
