/**
 * Capture renderer input from a freshly scanned Foundry dataset:
 * bun apps/spyglass/scripts/capture-fixture.ts <dataset output directory>
 *
 * Commit the resulting test/fixtures/spyglass.json to refresh the reference
 * geometry when the workspace's packages change.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadImports, loadSpyglass } from "../src/web/layout/load-spyglass";

const [directory] = process.argv.slice(2);
if (!directory) {
  throw new Error("Pass the scanned Foundry dataset's output directory.");
}
const root = resolve(directory);
const dataMount = /^\.\/data\//;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input) => {
  const path = String(input);
  if (!dataMount.test(path)) {
    throw new Error(`Unexpected dataset request: ${path}`);
  }
  try {
    return new Response(
      await readFile(resolve(root, path.replace(dataMount, "")))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Response(null, { status: 404 });
    }
    throw error;
  }
}) as typeof fetch;
try {
  const data = await loadSpyglass();
  data.fileEdges = await loadImports(data);
  await writeFile(
    resolve(import.meta.dirname, "../test/fixtures/spyglass.json"),
    `${JSON.stringify(data)}\n`
  );
} finally {
  globalThis.fetch = originalFetch;
}
