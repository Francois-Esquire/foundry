import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "~/lib/engine";
import { runSchedules } from "~/lib/schedule";
import { writeJson } from "~/lib/state/json";
import type { Schedule } from "~/lib/triggers";

export async function runSchedulesUntilStopped(
  engine: Engine,
  schedules: readonly Schedule[],
  stateDir: string | undefined,
  hasConfig: boolean,
  configPath: string,
  controller: AbortController = new AbortController(),
  print: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
  getSchedules?: () => readonly Schedule[]
): Promise<void> {
  if (controller.signal.aborted) {
    return;
  }
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const heartbeat =
    stateDir === undefined ? undefined : join(stateDir, "heartbeat.json");
  if (heartbeat !== undefined) {
    writeJson(heartbeat, {
      config: hasConfig ? configPath : null,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: 1,
    });
  }
  const options = {
    getSchedules,
    print,
    signal: controller.signal,
    state: stateDir,
  };
  try {
    await runSchedules(engine, schedules, options);
    // Nothing scheduled still means "run until stopped": the dashboard and
    // manual launches live on this loop.
    await untilAborted(controller.signal);
  } finally {
    controller.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (heartbeat !== undefined) {
      rmSync(heartbeat, { force: true });
    }
  }
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
