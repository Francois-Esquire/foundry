import { useEffect, useState } from "react";

import type { AtlasInternals } from "./internals";

import { loadInternals } from "./load-internals";

export function useArchitecture(
  packageId: string,
  survey: string,
  enabled: boolean
) {
  const [data, setData] = useState<AtlasInternals | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    void loadInternals(packageId, survey, controller.signal)
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
  }, [packageId, survey, enabled, attempt]);
  return {
    data,
    error,
    retry: () => {
      setError("");
      setAttempt((n) => n + 1);
    },
  };
}
