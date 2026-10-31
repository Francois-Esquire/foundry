import type { Engine } from "~/lib/engine";
import { runSchedules } from "~/lib/schedule";

export interface RunLoopOptions {
  readonly print?: (line: string) => void;
  /**
   * Stops the loop. Without one the loop stops on SIGINT or SIGTERM; a host
   * that passes one decides itself what stops it.
   */
  readonly signal?: AbortSignal;
}

/**
 * Run the engine's schedules, including those agents add later, until
 * stopped. This is the process's steady state; `claimProcess` is what says
 * this is the one process doing it for the workspace.
 */
export async function runSchedulesUntilStopped(
  engine: Engine,
  {
    print = (line) => {
      process.stdout.write(`${line}\n`);
    },
    signal,
  }: RunLoopOptions = {}
): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal === undefined) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else {
    signal.addEventListener("abort", stop, { once: true });
  }
  try {
    await runSchedules(engine, { print, signal: controller.signal });
  } finally {
    controller.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    signal?.removeEventListener("abort", stop);
  }
}
