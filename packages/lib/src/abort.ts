export function withAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  reason: () => unknown = () => signal.reason
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      try {
        reject(reason());
      } catch (error) {
        reject(error);
      }
    };
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
