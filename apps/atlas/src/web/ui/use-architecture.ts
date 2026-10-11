import { useEffect, useRef, useState } from "react";

import type { AtlasInternals } from "../internals";

import { loadInternals } from "../load-internals";
import { type IslandSource, sourceKey, type Territory } from "../types";

export function useArchitecture(
  territory: Pick<Territory, "id" | "fileRoles" | "files">,
  source: IslandSource,
  enabled: boolean
) {
  const { fileRoles, files, id: island } = territory;
  const survey = sourceKey(source);
  const latestSource = useRef(source);
  latestSource.current = source;
  const [data, setData] = useState<AtlasInternals | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    const { dataset, package: packageId } = latestSource.current;
    loadInternals({
      dataset,
      files,
      island,
      package: packageId,
      roles: fileRoles,
      signal: controller.signal,
    })
      .then((internals) => {
        if (!controller.signal.aborted) {
          setData(internals);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not read composition evidence."
          );
        }
      });
    return () => {
      controller.abort();
    };
  }, [files, fileRoles, island, survey, enabled, attempt]);
  return {
    data,
    error,
    retry: () => {
      setError("");
      setAttempt((n) => n + 1);
    },
  };
}
