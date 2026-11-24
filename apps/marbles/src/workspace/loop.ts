import type { Engine } from "~/lib/engine";
import { runScheduler } from "~/lib/schedule-loop";

export interface RunLoopOptions {
  readonly cancel?: AbortSignal;
  readonly print?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export async function runSchedulesUntilStopped(
  engine: Engine,
  {
    cancel,
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
    await runScheduler(engine, {
      ...(cancel === undefined ? {} : { cancel }),
      print,
      signal: controller.signal,
    });
  } finally {
    controller.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    signal?.removeEventListener("abort", stop);
  }
}
