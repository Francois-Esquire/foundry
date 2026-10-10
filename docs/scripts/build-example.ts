import { createHash } from "node:crypto";
import { cp, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";

const docs = resolve(import.meta.dirname, "..");
const root = await realpath(resolve(docs, ".."));
const atlas = dirname(
  fileURLToPath(import.meta.resolve("@foundry/atlas/package.json"))
);
const state = join(docs, ".cache", "atlas-example");
// The state directory's name, as apps/atlas/src/lib/state.ts derives it,
// until `atlas export` (1.8) replaces this script.
const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
const example = join(docs, "public", "atlas", "examples", "foundry");

const scan = spawn(
  [
    process.execPath,
    join(atlas, "dist/cli/atlas.js"),
    "scan",
    root,
    "--state",
    state,
  ],
  { stderr: "inherit", stdout: "inherit" }
);
if ((await scan.exited) !== 0) {
  throw new Error(
    "Atlas could not generate the Foundry documentation example."
  );
}

await rm(example, { force: true, recursive: true });
await cp(join(atlas, "dist/web"), example, { recursive: true });
await cp(join(state, id, "output"), join(example, "data"), { recursive: true });
process.stdout.write(
  "Atlas example ready at /atlas/examples/foundry/?view=map\n"
);
