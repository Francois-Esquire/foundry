import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "~/engine";
import { catalog } from "~/lib/catalog";
import type { Schedule } from "~/lib/triggers";
import { runLive } from "~/live";
import { runSchedules } from "~/schedule";
import { writeJson } from "~/state/json";
import type { Workspace as WorkspaceState } from "~/state/workspace";

export async function runSchedulesUntilStopped(
  engine: Engine,
  schedules: readonly Schedule[],
  workspace: WorkspaceState,
  stateDir: string | undefined,
  hasConfig: boolean,
  configPath: string,
  controller: AbortController = new AbortController(),
  print: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  }
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
  // A ws monitor has nothing to poll; files monitors keep their poll as a
  // net under the watcher.
  const live = schedules.flatMap((schedule) => {
    const spec = catalog.monitors.get(schedule.name);
    return spec === undefined || spec.kind === "http"
      ? []
      : [{ schedule, spec }];
  });
  const polled = schedules.filter(
    (schedule) => catalog.monitors.get(schedule.name)?.kind !== "ws"
  );
  const { host } = catalog.bindings();
  if (!host) {
    throw new Error("the runtime has no workspace catalogue for live monitors");
  }
  const options = { print, signal: controller.signal, state: stateDir };
  try {
    await Promise.all([
      runLive(engine, live, {
        ...options,
        root: workspace.root,
        workspaces: host.catalogue,
      }),
      runSchedules(engine, polled, options),
    ]);
  } finally {
    controller.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (heartbeat !== undefined) {
      rmSync(heartbeat, { force: true });
    }
  }
}
