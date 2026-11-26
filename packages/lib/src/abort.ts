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
