#!/usr/bin/env bun
import { echoInstance } from "~/lib/models/echo";
import { claudeCode as claudeCodePlugin } from "~/lib/providers/claude-code";

const { create } = claudeCodePlugin;
claudeCodePlugin.create = (setup) => {
  const created = create(setup);
  return {
    ...created,
    provider: echoInstance(created.provider, () => undefined),
  };
};
await import("~/process/generation");
