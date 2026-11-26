import { nativeDirectoryEntries, nativeRepositoryReader } from "./boundary";
import type { DiscoveryReader } from "./discovery-rules";
import { discoverUnitsWith } from "./discovery-rules";
import { createIgnorer } from "./ignore";
import type { SemanticsConfig, SemanticsDiscovery } from "./semantics-types";

const NATIVE_DISCOVERY_READER: DiscoveryReader = {
  ...nativeRepositoryReader,
  entries: nativeDirectoryEntries,
};

export function discoverSemanticsUnits(
  root: string,
  config: SemanticsConfig
): SemanticsDiscovery {
  return discoverUnitsWith(
    NATIVE_DISCOVERY_READER,
    createIgnorer(root),
    root,
    config
  );
}
