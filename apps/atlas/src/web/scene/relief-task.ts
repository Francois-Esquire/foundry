import {
  type PreparedRelief,
  prepareRelief,
  type ReliefRequest,
} from "./prepare-relief";

/** Superseded evidence never publishes a stale mesh. The worker owns all heavy sampling. */
export function prepareReliefTask(
  request: ReliefRequest,
  signal: AbortSignal
): Promise<PreparedRelief | undefined> {
  if (signal.aborted) {
    return Promise.resolve(undefined);
  }
  if (typeof Worker === "undefined") {
    return Promise.resolve(prepareRelief(request));
  }
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    const finish = (result?: PreparedRelief) => {
      signal.removeEventListener("abort", abort);
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      }
      resolve(result);
    };
    const abort = () => finish();
    const fallback = () =>
      finish(signal.aborted ? undefined : prepareRelief(request));
    try {
      worker = new Worker(new URL("./relief.worker.ts", import.meta.url), {
        type: "module",
      });
      signal.addEventListener("abort", abort, { once: true });
      worker.onmessage = (event: MessageEvent<PreparedRelief>) =>
        finish(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        fallback();
      };
      worker.postMessage(request);
    } catch {
      fallback();
    }
  });
}
