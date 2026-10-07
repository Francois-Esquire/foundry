import { useCallback, useRef, useState } from "react";

/** A failure as one line for the screen: the message, without an `Error:` prefix. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One piece of async work at a time, with its failure kept on screen. The ref
 * turns away a second `run` before React has re-rendered with `busy`, so a
 * double click or a held key cannot start the work twice.
 */
export function useAsyncAction() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback((work: () => Promise<void>) => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the ref to its initial value; earlier calls set it.
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(undefined);
    work()
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  }, []);
  const clear = useCallback(() => setError(undefined), []);
  return { busy, clear, error, run };
}
