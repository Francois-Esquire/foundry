import { existsSync } from "node:fs";
import { join } from "node:path";

import { isRecord, readJson, writeJson } from "~/state/json";

/** `<workspace>/schedules/<name>.json`: the last tick and when the next is due. */
export interface ScheduleHistory {
  /** Recorded so `status`, which never loads the config, can label a monitor. */
  readonly kind?: "monitor";
  readonly lastFinish: string;
  readonly lastStart: string;
  readonly lastStatus: "complete" | "failed";
  readonly nextDue: string;
}

export function writeScheduleHistory(
  dir: string,
  name: string,
  history: ScheduleHistory
): void {
  writeJson(join(dir, "schedules", `${name}.json`), { version: 1, ...history });
}

/** Only the field the loop seeds from; the rest is for humans and `status`. */
export function readLastFinish(dir: string, name: string): number | undefined {
  const path = join(dir, "schedules", `${name}.json`);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = readJson(path);
  const finished =
    isRecord(parsed) && typeof parsed.lastFinish === "string"
      ? Date.parse(parsed.lastFinish)
      : Number.NaN;
  return Number.isNaN(finished) ? undefined : finished;
}
