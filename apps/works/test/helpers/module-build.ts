import type { BuildRuntime } from "~/main/modules/builds/controller";
import type { ModuleLibrary } from "~/main/modules/library";

/** The build run a release published outside any build names as its builder. */
export const TEST_BUILD_RUN = "rn-test-build";

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
  async run({ progress, signal, source }) {
    signal.throwIfAborted();
    progress({ phase: "checking" });
    progress({ log: "Build passed", phase: "building" });
    return buildResult(source);
  },
};

/**
 * Publishes the Module's saved starter as a release whose Manifest is the
 * strict format with `manifest` merged in.
 */
export async function publishStrict(
  library: Pick<ModuleLibrary, "details" | "publish">,
  moduleId: string,
  tag: string,
  manifest: object
) {
  const details = await library.details(moduleId);
  if (!details?.binding) {
    throw new Error("Starter binding missing");
  }
  const { "foundry.module.json": legacyText = "{}" } = details.source;
  const published = await library.publish(moduleId, details.binding, {
    ...buildResult({
      ...details.source,
      "foundry.module.json": JSON.stringify({
        ...(JSON.parse(legacyText) as object),
        format: "foundry.module-manifest/1",
        persistence: { files: "installation" },
        ...manifest,
      }),
    }),
    builtBy: TEST_BUILD_RUN,
    tag,
  });
  return published.version;
}
