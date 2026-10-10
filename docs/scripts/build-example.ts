import { access, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";

const docs = resolve(import.meta.dirname, "..");
const root = await realpath(resolve(docs, ".."));
const atlas = join(
  dirname(fileURLToPath(import.meta.resolve("@foundry/atlas/package.json"))),
  "dist/cli/atlas.js"
);
const state = join(docs, ".cache", "atlas-example");
const example = join(docs, "public", "atlas", "examples", "foundry");

/** Runs the built CLI; `atlas export` replaces the previous example itself. */
async function run(args: string[]): Promise<void> {
  const child = spawn([process.execPath, atlas, ...args, "--state", state], {
    stderr: "inherit",
    stdout: "inherit",
  });
  if ((await child.exited) !== 0) {
    throw new Error(
      "Atlas could not generate the Foundry documentation example."
    );
  }
}

/**
 * The example is generated and gitignored. One written before static viewers
 * carried their marker is not recognized as a static viewer, so it goes.
 */
async function removeUnmarkedExample(): Promise<void> {
  const marked = await access(join(example, ".atlas-static-viewer.json")).then(
    () => true,
    () => false
  );
  if (!marked) {
    await rm(example, { force: true, recursive: true });
  }
}

await removeUnmarkedExample();
await run(["scan", root, "--quiet"]);
await run(["export", example, root]);
process.stdout.write(
  "Atlas example ready at /atlas/examples/foundry/?view=map\n"
);
