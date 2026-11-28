import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMissingPath } from "@foundry/lib/node/atomic-file";
import { engines } from "../../package.json" with { type: "json" };
import { startServer } from "../server/server";
import { savedCollection, savedDataset } from "./dataset-files";

export const DEFAULT_PORT = 4173;
const HIGHEST_PORT = 65_535;

export interface ServeOptions {
  port?: number;
  state?: string;
}

interface RunningServer {
  stop(): Promise<void>;
  url: URL;
}

export interface SpyglassServer extends RunningServer {
  root: string;
}

export interface CollectionServer extends RunningServer {
  roots: string[];
}

const VIEWER = resolve(
  import.meta.dirname,
  import.meta.filename.endsWith(".ts") ? "../../dist/web" : "../web"
);

export async function serve(
  root: string,
  options: ServeOptions = {}
): Promise<SpyglassServer> {
  const { port, viewer } = await serving(options);
  const { workspace } = await savedDataset(root, options.state);
  const server = startServer({ output: workspace.output, port, viewer });
  return {
    root: workspace.root,
    stop: () => server.stop(true),
    url: server.url,
  };
}

async function serveCollection(
  roots: readonly string[],
  options: ServeOptions = {}
): Promise<CollectionServer> {
  const { port, viewer } = await serving(options);
  const collection = await savedCollection(roots, options.state);
  const server = startServer({ collection, port, viewer });
  return {
    roots: collection.workspaces.map((workspace) => workspace.root),
    stop: () => server.stop(true),
    url: server.url,
  };
}

serve.collection = serveCollection;

async function serving(
  options: ServeOptions
): Promise<{ port: number; viewer: string }> {
  if (typeof globalThis.Bun === "undefined") {
    throw new Error(`Spyglass serve needs Bun (${engines.bun}).`);
  }
  const port = options.port ?? DEFAULT_PORT;
  checkPort(port);
  return { port, viewer: await viewerRoot() };
}

export function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > HIGHEST_PORT) {
    throw new Error("Port must be an integer between 0 and 65535.");
  }
}

export async function viewerRoot(): Promise<string> {
  try {
    if ((await stat(join(VIEWER, "index.html"))).isFile()) {
      return VIEWER;
    }
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
  }
  throw new Error(
    `The viewer's files are missing from ${VIEWER}. Reinstall the package, or build it first when running from source.`
  );
}
