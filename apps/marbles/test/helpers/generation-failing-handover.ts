#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { ExecutionRecords } from "~/lib/execution-records";

/**
 * An engine generation whose hand-overs of queued runs fail while the file
 * `MARBLES_TEST_FAIL_HANDOVER` names exists, as a store that does not
 * answer for a while would: a retiring generation keeps those runs queued
 * and tries them again once the file is gone.
 */
const marker = process.env.MARBLES_TEST_FAIL_HANDOVER ?? "";
const records = ExecutionRecords.prototype as unknown as {
  handQueued: (...args: unknown[]) => Promise<boolean>;
};
const { handQueued } = records;
records.handQueued = function (this: unknown, ...args: unknown[]) {
  if (marker !== "" && existsSync(marker)) {
    return Promise.reject(new Error("the test refuses this hand-over"));
  }
  return handQueued.apply(this, args);
};
await import("~/process/generation");
