#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { Engine } from "~/lib/engine";

const marker = process.env.MARBLES_TEST_FAIL_STOP ?? "";
const { stop } = Engine.prototype;
Engine.prototype.stop = function (
  this: Engine,
  ...args: Parameters<Engine["stop"]>
) {
  if (marker !== "" && existsSync(marker)) {
    rmSync(marker);
    return Promise.reject(new Error("the test refuses this drain"));
  }
  return stop.apply(this, args);
} as Engine["stop"];
await import("~/process/generation");
