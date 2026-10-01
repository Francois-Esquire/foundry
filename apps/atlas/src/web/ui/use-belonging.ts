import { useEffect, useMemo, useState } from "react";
import { belongingRegions, compositeRegions } from "../belonging";
import { deriveHierarchy } from "../hierarchy";
import type { AtlasInternals } from "../internals";
import { loadInternals } from "../load-internals";
import type { Territory } from "../types";
import { useNaturalFeatures } from "./use-natural-features";

export function useBelonging(territory: Territory | undefined, survey: string) {
  const [result, setResult] = useState<{
    id: string;
    survey: string;
    data?: AtlasInternals;
    error?: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const id = territory?.id;
  useEffect(() => {
    if (!id) {
      return;
    }
    const controller = new AbortController();
    loadInternals(id, survey, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setResult({ data, id, survey });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({
            error:
              error instanceof Error
                ? error.message
                : "Could not load belonging.",
            id,
            survey,
          });
        }
      });
    return () => {
      controller.abort();
    };
  }, [id, survey, attempt]);
  const current =
    result?.id === id && result?.survey === survey ? result : undefined;
  const regions = useMemo(
    () =>
      current?.data && territory
        ? belongingRegions(current.data, territory)
        : [],
    [current, territory]
  );
  const hierarchy = useMemo(
    () =>
      current?.data
        ? deriveHierarchy(current.data.responsibilities)
        : undefined,
    [current]
  );
  const composites = useMemo(
    () => (hierarchy ? compositeRegions(hierarchy, regions) : []),
    [hierarchy, regions]
  );
  const features = useNaturalFeatures(territory, regions, current?.data);
  return {
    composites,
    data: current?.data,
    error: current?.error,
    features,
    loading: !!id && !current,
    regions,
    retry: () => {
      setResult(undefined);
      setAttempt((n) => n + 1);
    },
  };
}
