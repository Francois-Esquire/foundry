/**
 * Stops waiting for read-only work when cancelled. The work is still observed
 * to completion, but its result is discarded. Never use this to abandon cleanup
 * or a write whose completion the caller must confirm.
 */
export function withAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  reason: () => unknown = () => signal.reason
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
