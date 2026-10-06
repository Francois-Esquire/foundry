/** Settle with `pending`, or reject with the signal's reason once it aborts. */
export async function raceAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}
