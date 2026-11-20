#!/usr/bin/env bun
import { echoInstance } from "~/lib/models/echo";
import { claudeCodePlugin } from "~/lib/providers/plugins";

const { create } = claudeCodePlugin;
claudeCodePlugin.create = (setup) => {
  const created = create(setup);
  return {
    ...created,
    provider: echoInstance(created.provider, () => undefined),
  };
};
await import("~/process/generation");
