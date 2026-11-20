#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { Engine } from "~/lib/engine";

const stall = process.env.MARBLES_TEST_STALL_ADOPT ?? "";
const release = process.env.MARBLES_TEST_RELEASE_ADOPT ?? "";
const { adopt } = Engine.prototype;
Engine.prototype.adopt = async function (this: Engine, runId: string) {
  process.stderr.write(`adopt asked ${runId}\n`);
  if (stall !== "" && existsSync(stall)) {
    rmSync(stall);
    process.stderr.write(`adopt stalls ${runId}\n`);
    while (!existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.stderr.write(`adopt resumes ${runId}\n`);
  }
  return await adopt.call(this, runId);
};
await import("~/process/generation");
