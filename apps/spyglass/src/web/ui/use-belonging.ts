import { useEffect, useMemo, useRef, useState } from "react";
import { type IslandSource, sourceKey, type Territory } from "../data/types";
import { belongingRegions, compositeRegions } from "../layout/belonging";
import type { SpyglassInternals } from "../layout/internals";
import { loadInternals } from "../layout/load-internals";
import { useNaturalFeatures } from "./use-natural-features";

export function useBelonging(
  territory: Territory | undefined,
  source: IslandSource | undefined,
  volcanic = false,
  streams = false
) {
  // The source as one value, so the read runs again only when it changes.
  const survey = source ? sourceKey(source) : "";
  const latestSource = useRef(source);
  latestSource.current = source;
  const [result, setResult] = useState<{
    id: string;
    volcanic: boolean;
    survey: string;
    data?: SpyglassInternals;
    error?: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const id = territory?.id;
  const roles = territory?.fileRoles;
  const files = territory?.files;
  useEffect(() => {
    const from = latestSource.current;
    if (!(id && files && from)) {
      return;
    }
    const controller = new AbortController();
    loadInternals({
      dataset: from.dataset,
      files,
      island: id,
      package: from.package,
      recordedChange: volcanic,
      roles,
      signal: controller.signal,
    })
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
  }, [id, files, roles, survey, attempt, volcanic]);
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
