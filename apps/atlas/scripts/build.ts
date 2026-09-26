import { resolve } from "node:path";
import { build as buildCli } from "bun";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const result = await buildCli({
  entrypoints: [resolve(root, "src/cli/index.ts")],
  naming: "atlas.js",
  outdir: resolve(root, "dist/cli"),
  packages: "external",
  sourcemap: "external",
  target: "bun",
});
if (!result.success) {
  throw new AggregateError(result.logs, "Atlas CLI build failed");
}
const worker = await buildCli({
  entrypoints: [resolve(root, "src/lib/semantics-worker.ts")],
  outdir: resolve(root, "dist/cli"),
  packages: "external",
  target: "bun",
});
if (!worker.success) {
  throw new AggregateError(worker.logs, "Atlas worker build failed");
}
await build({ configFile: resolve(root, "vite.config.ts") });
