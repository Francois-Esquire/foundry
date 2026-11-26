import { configureCache, LocalProvider } from "../../local";
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
