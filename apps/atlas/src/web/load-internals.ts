import type { FrequentChange } from "../lib/lenses/frequent-change-types";
import { pinnedRead, viewerDataset } from "./dataset";
import type { FrequentChangeEvidence } from "./internals";
import { bindInternals } from "./internals";
import type { AtlasFile, DatasetRef, Territory } from "./types";

/** What `loadInternals` reads one island's internals for. */
export interface InternalsRequest {
  /** The island's workspace's dataset, which the read is pinned to. */
  dataset: DatasetRef;
  /** The island's files as the map holds them: the internals bind to them by path. */
  files: readonly Pick<AtlasFile, "id" | "path">[];
  /** The island's id on the map, which overlays name; its package id where absent. */
  island?: string;
  /** The package's bare id in that dataset. */
  package: string;
  recordedChange?: boolean;
  /** The `file-roles` lens's entry the map read at load from that dataset, so the lens is not read again. */
  roles: Territory["fileRoles"];
  signal: AbortSignal;
}

/**
 * One package's internals, from its workspace's dataset, pinned to the
 * manifest the map read. The manifest is read again once the files are in,
 * so a scan that replaces the dataset mid-read cannot mix two datasets.
 * They bind to the island's own files, so the module index is not read.
 */
export async function loadInternals(request: InternalsRequest) {
  const {
    dataset,
    files,
    island,
    package: packageId,
    recordedChange = false,
    roles,
    signal,
  } = request;
  const { internals, frequentChange } = await readEvidence(
    packageId,
    dataset,
    signal,
    recordedChange
  );
  const { topology, locality, responsibilities, primitives, rewiring, review } =
    internals;
  const bound = bindInternals(
    topology,
    locality,
    files,
    responsibilities,
    roles
  );
  if (recordedChange) {
    bound.frequentChange = islandChange(frequentChange, packageId);
  }
  bound.architecture = { primitives, review, rewiring };
  if (island !== undefined) {
    bound.island = island;
  }
  return bound;
}

async function readEvidence(
  packageId: string,
  dataset: DatasetRef,
  signal: AbortSignal,
  recordedChange: boolean
) {
  return await pinnedRead(async () => {
    const reader = viewerDataset({ dataset, signal });
    const [internals, frequentChange] = await Promise.all([
      reader.internals(packageId),
      // A dataset saved before the lens has none; the island says so.
      recordedChange
        ? reader.lens("frequent-change").catch(() => undefined)
        : undefined,
    ]);
    await viewerDataset({ dataset, signal }).manifest();
    return { frequentChange, internals };
  });
}

/** The island's entry in the `frequent-change` lens, or why it has none. */
function islandChange(
  lens: FrequentChange | undefined,
  packageId: string
): FrequentChangeEvidence {
  if (lens === undefined) {
    return { available: false, reason: "not-saved" };
  }
  const entry = lens.packages.find((pkg) => pkg.id === packageId);
  return entry
    ? {
        available: true,
        files: entry.files,
        gate: lens.gate,
        history: entry.history,
      }
    : { available: false, reason: "no-history" };
}
