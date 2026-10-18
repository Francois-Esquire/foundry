import { useMemo } from "react";
import type { BelongingRegion } from "../belonging";
import type { Territory } from "../data/types";
import type { SpyglassInternals } from "../internals";
import { naturalFeatures } from "../natural-features";

/** Evidence geometry is memoized independently of camera movement. */
export function useNaturalFeatures(
  territory: Territory | undefined,
  regions: BelongingRegion[],
  data: SpyglassInternals | undefined,
  volcanic = false,
  streams = false
) {
  return useMemo(() => {
    if (!(territory && data)) {
      return;
    }
    return naturalFeatures(
      territory,
      regions,
      {
        fileIds: data.fileIds,
        fileRoles: data.fileRoles,
        frequentChange: volcanic ? data.frequentChange : undefined,
        relationships: data.responsibilities.relationships,
        unresolved: data.responsibilities.unresolved,
      },
      streams
    );
  }, [data, regions, territory, volcanic, streams]);
}
