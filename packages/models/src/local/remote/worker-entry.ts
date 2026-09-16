/**
 * Executable entry for the unbound local-inference worker. Started via
 * `fork(worker-entry, ["--cache", <dir>])` from {@link forkLocalWorker};
 * hosts a real LocalProvider and serves the bridge protocol over Node IPC.
 * Exits when the host disconnects so no orphan keeps a model in RAM.
 */

import { configureCache, LocalProvider } from "../provider";
import { processIpcTransport } from "./transport";
import { runLocalWorker } from "./worker";

const cacheFlag = process.argv.indexOf("--cache");
const cacheDir = cacheFlag === -1 ? undefined : process.argv[cacheFlag + 1];
if (!cacheDir) {
  console.error("[remote-local worker] missing required --cache <dir>");
  process.exit(1);
}

configureCache(cacheDir);

const transport = processIpcTransport();
process.on("disconnect", () => {
  process.exit(0);
});

runLocalWorker(transport, new LocalProvider());
