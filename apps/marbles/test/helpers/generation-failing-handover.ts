#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { Engine } from "~/lib/engine";
import { RunQueue } from "~/lib/runs/queue";

const marker = process.env.MARBLES_TEST_FAIL_HANDOVER ?? "";
const busy = process.env.MARBLES_TEST_FAIL_ORPHAN_TAKE;
const { recover, retire } = RunQueue.prototype;
RunQueue.prototype.retire = function (
  this: RunQueue,
  ...args: Parameters<RunQueue["retire"]>
) {
  if (marker !== "" && existsSync(marker)) {
    return Promise.reject(new Error("the test refuses this hand-over"));
  }
  return retire.apply(this, args);
};
RunQueue.prototype.recover = function (this: RunQueue) {
  if (busy !== undefined && existsSync(busy)) {
    rmSync(busy);
    return Promise.reject(new Error("injected SQLITE_BUSY during orphan take"));
  }
  return recover.apply(this);
};
if (process.env.MARBLES_TEST_DROP_HANDED === "1") {
  const { retire: retireEngine } = Engine.prototype;
  Engine.prototype.retire = function (
    this: Engine,
    successor: Parameters<Engine["retire"]>[0],
    options: Parameters<Engine["retire"]>[1] = {}
  ) {
    const { onHanded: _dropped, ...kept } = options;
    return retireEngine.call(this, successor, kept);
  } as Engine["retire"];
}
await import("~/process/generation");
