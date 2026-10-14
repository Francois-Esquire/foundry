import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMissingPath } from "@foundry/lib/atomic-file";
import { engines } from "../../package.json" with { type: "json" };
import { startServer } from "../server/server";
import { savedCollection, savedDataset } from "./dataset-files";

/** The port `serve` and the CLI use when none is given. */
export const DEFAULT_PORT = 4173;
const HIGHEST_PORT = 65_535;

export interface ServeOptions {
  /** The port on 127.0.0.1, an integer from 0 to 65535; 0 picks a free one. Default 4173. */
  port?: number;
  /** The state root (`--state`), as `ScanOptions.state`. Default `~/.foundry/spyglass`. */
  state?: string;
}

/** What every running server has: its address and the way to stop it. */
interface RunningServer {
  /** Stops listening and closes open connections; resolves once the port is free. */
  stop(): Promise<void>;
  /** The viewer's address, such as `http://127.0.0.1:4173/`. */
  url: URL;
}

/** A running server: the viewer at `url`, the saved dataset under `url/data/`. */
export interface SpyglassServer extends RunningServer {
  /** The workspace root, resolved through symlinks. */
  root: string;
}

/**
 * A running server for a collection: the viewer at `url`, the collection
 * manifest at `url/data/collection-manifest.json`, and each workspace's
 * dataset under `url/data/<workspace id>/`.
 */
export interface CollectionServer extends RunningServer {
  /** Each workspace root, resolved through symlinks, in the collection's order. */
  roots: string[];
}

/**
 * The viewer's built files. Every built entry and chunk sits in `dist/lib`,
 * so from a bundle they are `../web`; from source they are the package's
 * `dist/web`, which the build writes. The workers are found the same way
 * (`worker-runtime.ts`).
 */
const VIEWER = resolve(
  import.meta.dirname,
  import.meta.filename.endsWith(".ts") ? "../../dist/web" : "../web"
);

/**
 * Serves the workspace's saved dataset and the viewer on 127.0.0.1. Fails
 * outside Bun, on an invalid port, when the viewer's files are missing, when
 * no dataset is saved, or when it was saved with another schema version.
 * Takes no lock: a scan that runs meanwhile replaces the dataset atomically,
 * and later requests see it.
 */
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

/**
 * Serves a collection's saved datasets and the viewer on 127.0.0.1: each
 * workspace's dataset under its id, and the collection manifest, derived
 * from the manifests saved at each request. Fails as `serve` does, naming
 * the first workspace with no saved dataset, and as `resolveCollection`
 * does. Takes no lock: a scan of one workspace meanwhile is seen by later
 * requests, the collection manifest included.
 */
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

/** The checks before anything is read: Bun, the port, and the viewer's files. */
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

/** Throws unless `port` is an integer from 0 to 65535. */
export function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > HIGHEST_PORT) {
    throw new Error("Port must be an integer between 0 and 65535.");
  }
}

/** The directory of the viewer's built files; throws when they are missing. */
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
