import { discoverSemanticsUnits, requireDeclared } from "./semantics-discover";
import {
  collectWorkspaceInputs,
  startOfUtcDay,
  workspaceInputsHash,
} from "./semantics-fingerprint";
import type { DatasetManifest, SemanticsConfig } from "./semantics-types";

export const STALE_DATASET =
  "The saved dataset is stale: the sources, Git's commits or tracked files, the configuration, or the UTC day changed since the scan. Run spyglass scan.";
export const UNRECORDED_DATASET =
  "The saved dataset records no inputs fingerprint, since an earlier Spyglass saved it, so it cannot be shown to be current. Run spyglass scan.";

export async function datasetCurrency(
  root: string,
  manifest: DatasetManifest,
  config?: SemanticsConfig
): Promise<"current" | "stale" | "unrecorded"> {
  const recorded = manifest.generation.inputs;
  if (recorded === undefined) {
    return "unrecorded";
  }
  const units =
    config === undefined
      ? manifest.packages
      : requireDeclared(root, discoverSemanticsUnits(root, config)).units;
  const inputs = await collectWorkspaceInputs({
    config: config ?? { exclude: [] },
    now: startOfUtcDay(new Date()),
    root,
    units,
  });
  const hash = workspaceInputsHash(
    config === undefined ? { ...inputs, config: recorded.config } : inputs
  );
  return hash === recorded.hash ? "current" : "stale";
}
