#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { Engine } from "~/lib/engine";

const marker = process.env.MARBLES_TEST_REFUSE_LAUNCH ?? "";
const { launch } = Engine.prototype;
Engine.prototype.launch = function (
  this: Engine,
  ...args: Parameters<Engine["launch"]>
) {
  if (marker !== "" && existsSync(marker)) {
    rmSync(marker);
    const error = new Error("the test refuses this launch as retiring");
    error.name = "EngineRetiringError";
    return Promise.reject(error);
  }
  return launch.apply(this, args);
} as Engine["launch"];
await import("~/process/generation");
