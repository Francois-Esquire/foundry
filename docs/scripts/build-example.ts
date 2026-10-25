import { access, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";

const docs = resolve(import.meta.dirname, "..");
const root = await realpath(resolve(docs, ".."));
// The bin sits beside the library entry; the exports map names only `.`.
const spyglass = join(
  dirname(fileURLToPath(import.meta.resolve("@foundry.sh/spyglass"))),
  "spyglass.js"
);
const state = join(docs, ".cache", "spyglass-example");
const example = join(docs, "public", "spyglass", "examples", "foundry");

/** Runs the built CLI; `spyglass export` replaces the previous example itself. */
async function run(args: string[]): Promise<void> {
  const child = spawn([process.execPath, spyglass, ...args, "--state", state], {
    stderr: "inherit",
    stdout: "inherit",
  });
  if ((await child.exited) !== 0) {
    throw new Error(
      "Spyglass could not generate the Foundry documentation example."
    );
  }
}

/**
 * The example is generated and gitignored. One written before static viewers
 * carried their marker is not recognized as a static viewer, so it goes.
 */
async function removeUnmarkedExample(): Promise<void> {
  const marked = await access(
    join(example, ".spyglass-static-viewer.json")
  ).then(
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
  "Spyglass example ready at /spyglass/examples/foundry/?view=map\n"
);
