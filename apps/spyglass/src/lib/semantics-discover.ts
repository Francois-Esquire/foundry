import { nativeDirectoryEntries, nativeRepositoryReader } from "./boundary";
import type { DiscoveryReader } from "./discovery-rules";
import { discoverUnitsWith } from "./discovery-rules";
import { createIgnorer } from "./ignore";
import type { SemanticsConfig, SemanticsDiscovery } from "./semantics-types";

// Native workspace discovery. The rules are `discovery-rules.ts`, which this
// module answers with native reads and the checkout's `.gitignore` files.

const NATIVE_DISCOVERY_READER: DiscoveryReader = {
  ...nativeRepositoryReader,
  entries: nativeDirectoryEntries,
};

/**
 * Every directory the workspace declaration's package patterns match is a
 * unit; it becomes an analyzable package when it has a named manifest and
 * TypeScript sources. Without a declaration, inspect the root package itself. A directory two patterns match is inspected once, for
 * the first.
 */
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
