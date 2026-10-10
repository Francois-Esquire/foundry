import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMissingPath } from "@foundry/lib/atomic-file";
import { engines } from "../../package.json" with { type: "json" };
import { startServer } from "../server/server";
import { DatasetNotFoundError, datasetReader } from "./dataset";
import { fileTransport } from "./dataset-files";
import type { WorkspaceState } from "./state";
import { workspaceState } from "./state";

/** The port `serve` and the CLI use when none is given. */
export const DEFAULT_PORT = 4173;
const HIGHEST_PORT = 65_535;

export interface ServeOptions {
  /** The port on 127.0.0.1, an integer from 0 to 65535; 0 picks a free one. Default {@link DEFAULT_PORT}. */
  port?: number;
  /** The state root (`--state`), as `ScanOptions.state`. Default `~/.foundry/atlas`. */
  state?: string;
}

/** A running server: the viewer at `url`, the saved dataset under `url/data/`. */
export interface AtlasServer {
  /** The workspace root, resolved through symlinks. */
  root: string;
  /** Stops listening and closes open connections; resolves once the port is free. */
  stop(): Promise<void>;
  /** The viewer's address, such as `http://127.0.0.1:4173/`. */
  url: URL;
}

/**
 * The viewer's built files. Every built entry sits one directory under
 * `dist/` (`dist/cli/atlas.js` today), so from a bundle they are `../web`;
 * from source they are the package's `dist/web`, which the build writes.
 * The analysis worker is found the same way (`semantics.ts`).
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
): Promise<AtlasServer> {
  if (typeof globalThis.Bun === "undefined") {
    throw new Error(`Atlas serve needs Bun (${engines.bun}).`);
  }
  const port = options.port ?? DEFAULT_PORT;
  checkPort(port);
  const state = await workspaceState(root, options.state);
  const viewer = await viewerRoot();
  await checkDataset(state);
  const server = startServer({
    output: state.output,
    port,
    viewer,
  });
  return {
    root: state.root,
    stop: () => server.stop(true),
    url: server.url,
  };
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

async function checkDataset(state: WorkspaceState): Promise<void> {
  try {
    await datasetReader(fileTransport(state.output)).manifest();
  } catch (error) {
    if (error instanceof DatasetNotFoundError) {
      throw new Error(
        `No dataset found for ${state.root} in ${state.output}. Run atlas scan to save one.`,
        { cause: error }
      );
    }
    throw error;
  }
}
