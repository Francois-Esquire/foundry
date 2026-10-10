import { DatasetReplacedError } from "../lib/dataset";
import { viewerDataset } from "./dataset";
import { bindInternals } from "./internals";

/**
 * One package's internals, from the dataset whose manifest was saved at
 * `pin`: the map's own dataset. The manifest is read again once the files
 * are in, so a scan that replaces the dataset mid-read cannot mix two
 * datasets.
 */
export async function loadInternals(
  packageId: string,
  pin: string,
  signal: AbortSignal,
  recordedChange = false
) {
  const { internals, index, report } = await readEvidence(
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
    responsibilities
  );
  bound.churn = report?.churn;
  bound.architecture = { primitives, review, rewiring };
  return bound;
}

async function readEvidence(
  packageId: string,
  pin: string,
  signal: AbortSignal,
  recordedChange: boolean
) {
  try {
    const reader = viewerDataset({ pin, signal });
    const [internals, index, report] = await Promise.all([
      reader.internals(packageId),
      reader.moduleIndex(),
      recordedChange
        ? reader.packageReport(packageId).catch(() => undefined)
        : undefined,
    ]);
    await viewerDataset({ pin, signal }).manifest();
    return { index, internals, report };
  } catch (error) {
    if (error instanceof DatasetReplacedError) {
      throw new Error(
        "A later scan replaced the dataset. Reload Atlas to see it.",
        { cause: error }
      );
    }
    throw error;
  }
}
