#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { Engine } from "~/lib/engine";

const marker = process.env.MARBLES_TEST_HANG_ADOPT ?? "";
const { adopt } = Engine.prototype;
Engine.prototype.adopt = function (this: Engine, runId: string) {
  if (marker !== "" && existsSync(marker)) {
    rmSync(marker);
    process.stderr.write(`adopt hangs for ${runId}\n`);
    return new Promise<boolean>(() => undefined);
  }
  return adopt.call(this, runId);
};
await import("~/process/generation");
