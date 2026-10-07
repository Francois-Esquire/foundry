import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "~/lib/engine";
import { runSchedules } from "~/lib/schedule";
import { writeJson } from "~/lib/state/json";

export interface RunLoopOptions {
  /** The authoring source the heartbeat names; null without one. */
  readonly config: string | null;
  readonly print?: (line: string) => void;
  /**
   * Stops the loop. Without one the loop stops on SIGINT or SIGTERM; a host
   * that passes one decides itself what stops it.
   */
  readonly signal?: AbortSignal;
}

/**
 * Run the engine's schedules, including those agents add later, until
 * stopped. While it runs, a heartbeat in the engine's state dir tells
 * `status` this workspace has a live loop.
 */
export async function runSchedulesUntilStopped(
  engine: Engine,
  {
    config,
    print = (line) => {
      process.stdout.write(`${line}\n`);
    },
    signal,
  }: RunLoopOptions
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
  const { state } = engine;
  const heartbeat =
    state === undefined ? undefined : join(state, "heartbeat.json");
  if (heartbeat !== undefined) {
    writeJson(heartbeat, {
      config,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: 1,
    });
  }
  try {
    await runSchedules(engine, { print, signal: controller.signal });
  } finally {
    controller.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    signal?.removeEventListener("abort", stop);
    if (heartbeat !== undefined) {
      rmSync(heartbeat, { force: true });
    }
  }
}
