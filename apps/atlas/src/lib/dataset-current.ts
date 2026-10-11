import { discoverSemanticsUnits, requireDeclared } from "./semantics-discover";
import {
  collectWorkspaceInputs,
  startOfUtcDay,
  workspaceInputsHash,
} from "./semantics-fingerprint";
import type { DatasetManifest, SemanticsConfig } from "./semantics-types";

// Whether a saved dataset still describes the workspace: the inputs hash its
// manifest recorded (3.6) against the same hash recomputed now, about two
// seconds of hashing, one cruise, and one Git log. The hash moves with any
// source edit, any commit or tracked file added or removed, another UTC day
// (the scan's clock), an edited exclusion or profile, or another analysis
// version. So a dataset is current only on the UTC day it was scanned, with
// no commit and no source edit since.

/** Why a dataset is not current, as plan and apply say it. */
export const STALE_DATASET =
  "The saved dataset is stale: the sources, Git's commits or tracked files, the configuration, or the UTC day changed since the scan. Run atlas scan.";
export const UNRECORDED_DATASET =
  "The saved dataset records no inputs fingerprint, since an earlier Atlas saved it, so it cannot be shown to be current. Run atlas scan.";

/**
 * `current` when the manifest's recorded inputs hash equals the hash of the
 * workspace now. With `config`, as apply loads it, every component is
 * recomputed. Without it, as plan runs no configuration, the exclusions-
 * and-profile component is the one the manifest recorded, so an exclusion
 * edited since the scan is not seen; apply, which authorizes again under
 * the configuration, sees it.
 */
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
