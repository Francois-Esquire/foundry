#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { HostedWorkspaces } from "~/workspace/hosted";

const marker = process.env.MARBLES_TEST_THROW_START ?? "";
const { stageRegistered } = HostedWorkspaces.prototype;
HostedWorkspaces.prototype.stageRegistered = async function (
  this: HostedWorkspaces
) {
  const staged = await stageRegistered.call(this);
  return {
    ...staged,
    start: () =>
      marker !== "" && existsSync(marker)
        ? Promise.reject(new Error("the test throws in this start"))
        : staged.start(),
  };
};
await import("~/process/generation");
