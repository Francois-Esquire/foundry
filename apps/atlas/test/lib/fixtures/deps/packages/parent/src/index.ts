import type { SatelliteState } from "@deps/satellite";
import type { SharedConfig } from "@deps/shared";

import { alphaTask } from "@deps/alpha";
import { pick } from "@deps/beta";
import { gammaCap } from "@deps/gamma";
import { log, trace } from "@deps/logger";
import { launchSatellite } from "@deps/satellite";
import { sharedInit, sharedRun } from "@deps/shared";

export function orchestrate(config: SharedConfig): number {
  const state: SatelliteState = launchSatellite();
  log(state.id);
  log("begin");
  log("middle");
  log("end");
  trace("done");
  const base = sharedInit(config) + sharedRun() + alphaTask() + gammaCap;
  return pick("on") === "on" ? base : 0;
}
