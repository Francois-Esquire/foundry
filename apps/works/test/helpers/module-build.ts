import { vi } from "vitest";
import type { BuildRuntime } from "~/main/modules/builds/controller";

export function buildResult(source: Record<string, string>) {
  return {
    outputs: {
      "packages/app/dist/index.html": new TextEncoder().encode(
        "<!doctype html><h1>Built</h1>"
      ),
      "packages/server/dist/index.js": new TextEncoder().encode("export {};"),
    },
    source: { ...source, "bun.lock": '{ "lockfileVersion": 1 }' },
  };
}
export const successfulBuildRuntime: BuildRuntime = {
  async run(source, signal, progress) {
    signal.throwIfAborted();
    progress({ phase: "checking" });
    progress({ log: "Build passed", phase: "building" });
    return buildResult(source);
  },
  shutdown: vi.fn(async () => undefined),
};
