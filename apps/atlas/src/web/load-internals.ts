import type { FrequentChange } from "../lib/lenses/frequent-change-types";
import { pinnedRead, viewerDataset } from "./dataset";
import type { FrequentChangeEvidence } from "./internals";
import { bindInternals } from "./internals";
import type { Territory } from "./types";

/**
 * One package's internals, from the dataset whose manifest was saved at
 * `pin`: the map's own dataset. The manifest is read again once the files
 * are in, so a scan that replaces the dataset mid-read cannot mix two
 * datasets. `roles` is the `file-roles` lens's entry the map read at load
 * from that same dataset, so the lens is not read again.
 */
export async function loadInternals(
  packageId: string,
  roles: Territory["fileRoles"],
  pin: string,
  signal: AbortSignal,
  recordedChange = false
) {
  const { internals, index, frequentChange } = await readEvidence(
    packageId,
    pin,
    signal,
    recordedChange
  );
  const { topology, locality, responsibilities, primitives, rewiring, review } =
    internals;
  const bound = bindInternals(
    topology,
    locality,
    index.modules.filter((file) => file.package === packageId),
    responsibilities,
    roles
  );
  if (recordedChange) {
    bound.frequentChange = islandChange(frequentChange, packageId);
  }
  bound.architecture = { primitives, review, rewiring };
  return bound;
}

async function readEvidence(
  packageId: string,
  pin: string,
  signal: AbortSignal,
  recordedChange: boolean
) {
  return await pinnedRead(async () => {
    const reader = viewerDataset({ pin, signal });
    const [internals, index, frequentChange] = await Promise.all([
      reader.internals(packageId),
      reader.moduleIndex(),
      // A dataset saved before the lens has none; the island says so.
      recordedChange
        ? reader.lens("frequent-change").catch(() => undefined)
        : undefined,
    ]);
    await viewerDataset({ pin, signal }).manifest();
    return { frequentChange, index, internals };
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
