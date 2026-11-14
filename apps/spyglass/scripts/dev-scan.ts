import { resolve } from "node:path";
import { createServer } from "vite";
import { DEFAULT_PORT } from "../src/lib/serve";
import { analysisAsset } from "./build";

// The scan page's development server, with hot reload. The browser analysis
// asset is built first, as production builds it, into a public directory
// of this server's own, so the page loads it from `analysis/` beside
// itself exactly as it does on a site. Rerun after changing analysis code.

const root = resolve(import.meta.dirname, "..");
const assets = resolve(root, ".cache", "scan-dev");
await analysisAsset(resolve(assets, "analysis"));
const server = await createServer({
  configFile: resolve(root, "vite.config.ts"),
  mode: "scan",
  publicDir: assets,
  server: { host: "127.0.0.1", port: DEFAULT_PORT + 1 },
});
await server.listen();
server.printUrls();
