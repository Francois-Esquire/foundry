import { useMemo } from "react";
import type { BelongingRegion } from "../belonging";
import type { AtlasInternals } from "../internals";
import { naturalFeatures } from "../natural-features";
import type { Territory } from "../types";

/** Evidence geometry is memoized independently of camera movement. */
export function useNaturalFeatures(
  territory: Territory | undefined,
  regions: BelongingRegion[],
  data: AtlasInternals | undefined,
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
        churn: volcanic ? data.churn : undefined,
        fileIds: data.fileIds,
        recordedChange: volcanic,
        relationships: data.responsibilities.relationships,
        unresolved: data.responsibilities.unresolved,
      },
      streams
    );
  }, [data, regions, territory, volcanic, streams]);
}
