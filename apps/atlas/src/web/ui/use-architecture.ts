import { useEffect, useState } from "react";

import type { AtlasInternals } from "../internals";

import { loadInternals } from "../load-internals";
import type { Territory } from "../types";

export function useArchitecture(
  territory: Pick<Territory, "id" | "fileRoles">,
  survey: string,
  enabled: boolean
) {
  const { id: packageId, fileRoles } = territory;
  const [data, setData] = useState<AtlasInternals | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    loadInternals(packageId, fileRoles, survey, controller.signal)
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
  }, [packageId, fileRoles, survey, enabled, attempt]);
  return {
    data,
    error,
    retry: () => {
      setError("");
      setAttempt((n) => n + 1);
    },
  };
}
