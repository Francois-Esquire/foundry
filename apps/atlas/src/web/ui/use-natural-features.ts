import { useEffect, useState } from "react";
import type { BelongingRegion } from "../belonging";
import type { AtlasInternals } from "../internals";
import { type NaturalFeatures, naturalFeatures } from "../natural-features";
import type { Territory } from "../types";

/** Route once off the browser thread; never publish a previous island's drawing. */
export function useNaturalFeatures(
  territory: Territory | undefined,
  regions: BelongingRegion[],
  data: AtlasInternals | undefined,
  volcanic = false
) {
  const [result, setResult] = useState<{
    volcanic: boolean;
    features: NaturalFeatures;
    regions: BelongingRegion[];
  }>();
  useEffect(() => {
    if (!(territory && data)) {
      return;
    }
    const args: Parameters<typeof naturalFeatures> = [
      territory,
      regions,
      {
        churn: volcanic ? data.churn : undefined,
        fileIds: data.fileIds,
        recordedChange: volcanic,
        relationships: data.responsibilities.relationships,
        unresolved: data.responsibilities.unresolved,
      },
    ];
    let active = true;
    const publish = (features: NaturalFeatures) => {
      if (active) {
        setResult({ features, regions, volcanic });
      }
    };
    const fallback = () => publish(naturalFeatures(...args));
    if (typeof Worker === "undefined") {
      fallback();
      return;
    }
    let worker: Worker | undefined;
    try {
      worker = new Worker(
        new URL("../natural-features.worker.ts", import.meta.url),
        { type: "module" }
      );
      worker.onmessage = (event: MessageEvent<NaturalFeatures>) => {
        publish(event.data);
        worker?.terminate();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        worker?.terminate();
        fallback();
      };
      worker.postMessage(args);
    } catch {
      worker?.terminate();
      fallback();
    }
    return () => {
      active = false;
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
      }
      worker?.terminate();
    };
  }, [data, regions, territory, volcanic]);
  return result?.regions === regions && result.volcanic === volcanic
    ? result.features
    : undefined;
}
