import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { build as bunBuild } from "bun";
import { build } from "vite";
import { dependencies } from "../package.json" with { type: "json" };

const root = resolve(import.meta.dirname, "..");
const outdir = resolve(root, "dist/cli");
/**
 * Only declared dependencies stay imports. Workspace `@foundry/*` packages
 * are declared in devDependencies, so they are inlined and the published
 * package never names a private one.
 */
const external = Object.keys(dependencies);

async function bundle(entrypoint: string, naming?: string) {
  const result = await bunBuild({
    entrypoints: [resolve(root, entrypoint)],
    external,
    naming,
    outdir,
    target: "bun",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Atlas build failed: ${entrypoint}`);
  }
}

rmSync(outdir, { force: true, recursive: true });
await bundle("src/cli/index.ts", "atlas.js");
await bundle("src/lib/semantics-worker.ts");
await build({ configFile: resolve(root, "vite.config.ts") });
