#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { Engine } from "~/lib/engine";

/**
 * An engine generation whose workspace engines refuse to start while the
 * file `MARBLES_TEST_FAIL_START` names exists: a start that fails for a
 * reason no source edit changes, such as a database that does not answer,
 * and that clears on its own once the file is gone.
 */
const marker = process.env.MARBLES_TEST_FAIL_START ?? "";
const { start } = Engine.prototype;
Engine.prototype.start = function (this: Engine) {
  if (marker !== "" && existsSync(marker)) {
    return Promise.reject(new Error("the test refuses this start"));
  }
  return start.call(this);
};
await import("~/process/generation");
