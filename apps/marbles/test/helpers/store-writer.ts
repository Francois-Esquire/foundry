/**
 * One process writing a workspace's artifacts, sandbox containers and
 * workspace catalogue into a Marbles database another process made, as a
 * worker does: through the package stores over one writer handle
 * (`openDatabase`), scoped by the workspace id. Run by Bun as a subprocess,
 * never imported:
 *
 *   bun store-writer.ts <state> <artifacts> <name> <count> <roots> <shared> <go>
 *
 * It prints `ready`, waits for the file `go` so every writer starts at
 * once, then makes `count` of each: an artifact named `<name>-<i>` holding
 * `a.txt` with that text, a container started and closed (its row stays,
 * stopped), and the workspace `<roots>/<name>-<i>` loaded into the
 * catalogue; and, first in each round, loads `shared`, which every writer
 * loads too.
 * It exits 0 once everything is written and closed; any failure throws.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { openDatabase } from "~/database/open";
import { artifactBlobs, workspaceStores } from "~/database/stores";
import { stateDatabase } from "~/layout";
import { localCatalogue } from "~/lib/managers/workspaces";

/** The workspace every writer writes as: one scope, shared (`ws`, as the test reads it). */
const SCOPE = "ws";

const [state, artifacts, name, count, roots, shared, go] =
  process.argv.slice(2);
if (
  state === undefined ||
  artifacts === undefined ||
  name === undefined ||
  count === undefined ||
  roots === undefined ||
  shared === undefined ||
  go === undefined
) {
  throw new Error(
    "usage: bun store-writer.ts <state> <artifacts> <name> <count> <roots> <shared> <go>"
  );
}
// Generous, as a machine under load may hold the write lock a while.
const opened = await openDatabase(stateDatabase(state), {
  busyTimeout: 30_000,
});
if (opened === undefined) {
  throw new Error(`no Marbles database under ${state}`);
}
const stores = workspaceStores(opened.database, SCOPE);
const manager = new ArtifactManager({
  files: blobFiles(artifactBlobs(artifacts, SCOPE)),
  store: stores.artifacts,
});
const containers = createContainers({
  allowedMountRoots: [],
  instanceLabel: `store-writer-${name}`,
  runtime: createFakeContainerRuntime(),
  store: stores.containers,
});
const catalogue = localCatalogue({}, stores.workspaces);
process.stdout.write("ready\n");
while (!existsSync(go)) {
  await new Promise((settle) => setTimeout(settle, 5));
}
try {
  for (let index = 0; index < Number(count); index += 1) {
    const label = `${name}-${String(index)}`;
    // First, so every writer's first round races to register it.
    await catalogue.load({ path: shared });
    await manager.create({
      entries: {
        "a.txt": { bytes: new TextEncoder().encode(label), mime: "text/plain" },
      },
      name: label,
      type: "text/plain",
    });
    const container = await containers.start({
      format: "foundry.sandbox.container/1",
      mounts: [],
      workdir: "/workspace",
    });
    await container.close();
    const root = join(roots, label);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "own.txt"), label);
    await catalogue.load({ path: root });
  }
} finally {
  await containers.shutdown();
  await catalogue.closeAll();
  opened.close();
}
