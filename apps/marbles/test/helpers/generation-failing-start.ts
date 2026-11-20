#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { Engine } from "~/lib/engine";

const marker = process.env.MARBLES_TEST_FAIL_START ?? "";
const { start } = Engine.prototype;
Engine.prototype.start = function (this: Engine) {
  if (marker !== "" && existsSync(marker)) {
    return Promise.reject(new Error("the test refuses this start"));
  }
  return start.call(this);
};
await import("~/process/generation");
