#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { Engine } from "~/lib/engine";
import { HostedWorkspaces } from "~/workspace/hosted";

const release = process.env.MARBLES_TEST_RELEASE_RETIRE ?? "";
let retiring = 0;
const { retire } = Engine.prototype;
Engine.prototype.retire = async function (
  this: Engine,
  ...args: Parameters<Engine["retire"]>
) {
  retiring += 1;
  try {
    process.stderr.write("retire held\n");
    while (!existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await retire.apply(this, args);
  } finally {
    retiring -= 1;
  }
} as Engine["retire"];
const { close } = HostedWorkspaces.prototype;
HostedWorkspaces.prototype.close = function (this: HostedWorkspaces) {
  process.stderr.write(
    `hosts closing with ${String(retiring)} retire(s) under way\n`
  );
  return close.call(this);
};
await import("~/process/generation");
