import { useEffect, useMemo, useState } from "react";
import { belongingRegions, compositeRegions } from "../belonging";
import type { AtlasInternals } from "../internals";
import { loadInternals } from "../load-internals";
import type { Territory } from "../types";
import { useNaturalFeatures } from "./use-natural-features";

export function useBelonging(
  territory: Territory | undefined,
  survey: string,
  volcanic = false,
  streams = false
) {
  const [result, setResult] = useState<{
    id: string;
    volcanic: boolean;
    survey: string;
    data?: AtlasInternals;
    error?: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const id = territory?.id;
  const roles = territory?.fileRoles;
  useEffect(() => {
    if (!id) {
      return;
    }
    const controller = new AbortController();
    loadInternals(id, roles, survey, controller.signal, volcanic)
      .then((data) => {
        if (!controller.signal.aborted) {
          setResult({ data, id, survey, volcanic });
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
            volcanic,
          });
        }
      });
    return () => {
      controller.abort();
    };
  }, [id, roles, survey, attempt, volcanic]);
  const current =
    result?.id === id &&
    result?.survey === survey &&
    result.volcanic === volcanic
      ? result
      : undefined;
  const regions = useMemo(
    () =>
      current?.data && territory
        ? belongingRegions(current.data, territory)
        : [],
    [current, territory]
  );
  const groups = territory?.responsibilityGroups;
  const composites = useMemo(
    () => (groups ? compositeRegions(groups, regions) : []),
    [groups, regions]
  );
  const features = useNaturalFeatures(
    territory,
    regions,
    current?.data,
    volcanic,
    streams
  );
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
