import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Artifacts } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { openDatabase } from "~/database/open";
import { artifactBlobs, workspaceStores } from "~/database/stores";
import { stateDatabase } from "~/layout";
import { localWorkspaces } from "~/lib/managers/workspaces";

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
const opened = await openDatabase(stateDatabase(state), {
  busyTimeout: 30_000,
});
if (opened === undefined) {
  throw new Error(`no Marbles database under ${state}`);
}
const stores = workspaceStores(opened.database, SCOPE);
const manager = new Artifacts({
  files: blobFiles(artifactBlobs(artifacts, SCOPE)),
  store: stores.artifacts,
});
const containers = createContainers({
  allowedMountRoots: [],
  instanceLabel: `store-writer-${name}`,
  runtime: createFakeContainerRuntime(),
  store: stores.containers,
});
const catalogue = localWorkspaces({}, stores.workspaces);
process.stdout.write("ready\n");
while (!existsSync(go)) {
  await new Promise((settle) => setTimeout(settle, 5));
}
try {
  for (let index = 0; index < Number(count); index += 1) {
    const label = `${name}-${String(index)}`;
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
