import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The Spyglass scan page, as `@foundry.sh/spyglass`'s build writes it
// (dist/scan: the page and its browser analysis asset), copied whole to
// /spyglass/scan/ on this site. The page uses relative URLs, so the site's
// base path needs nothing more. Generated and gitignored.
const docs = resolve(import.meta.dirname, "..");
// The library entry is dist/lib/index.js; the page is dist/scan.
const page = join(
  dirname(fileURLToPath(import.meta.resolve("@foundry.sh/spyglass"))),
  "..",
  "scan"
);
const target = join(docs, "public", "spyglass", "scan");

await rm(target, { force: true, recursive: true });
await cp(page, target, { recursive: true });
process.stdout.write("Spyglass scan page ready at /spyglass/scan/\n");
