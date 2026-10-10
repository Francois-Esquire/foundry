// What a consumer of the installed package writes, as source the package
// test saves into its temporary consumer. Each imports `@foundry/atlas` by
// name, so the installed `exports` map is what resolves it.

/** The values the entry exports, sorted; nothing else is public. */
export const VALUE_EXPORTS = [
  "DATASET_SCHEMA_VERSION",
  "DatasetNotFoundError",
  "DatasetReplacedError",
  "HISTORY_SCHEMA_VERSION",
  "scan",
  "serve",
];

/**
 * Runs every library call against a workspace and prints what came back as
 * one line of JSON. Arguments: the workspace, a state root, and a state root
 * that holds no dataset.
 */
export const LIBRARY_SCRIPT = `
import * as atlas from "@foundry/atlas";
import { DatasetNotFoundError, DatasetReplacedError, scan, serve } from "@foundry/atlas";

const [workspace, state, empty] = process.argv.slice(2);
const failure = async (pending) => {
  try {
    await pending;
    return { rejected: false };
  } catch (error) {
    return { error, message: error.message, rejected: true };
  }
};

const full = await scan(workspace, { state });
const internals = await full.internals("@s/a");
const report = await full.packageReport("@s/a");
const workspaceReport = await full.workspaceReport();
const level = await scan.workspace(workspace, { state });
const replaced = await failure(full.internals("@s/a"));
const fresh = await scan.package(workspace, "@s/a");
const server = await serve(workspace, { port: 0, state });
const index = await fetch(server.url);
const served = await (await fetch(new URL("data/manifest.json", server.url))).text();
await server.stop();
const missing = await failure(serve(workspace, { port: 0, state: empty }));

console.log(JSON.stringify({
  exports: Object.keys(atlas).sort(),
  full: {
    internals: internals.topology.package.id,
    output: full.output,
    packages: full.manifest.packages.map((entry) => \`\${entry.id}:\${entry.status}\`),
    report: report.target.name,
    schemaVersion: full.manifest.schemaVersion,
    workspacePackages: workspaceReport.workspace.packageCount,
  },
  level: { internals: "internals" in level, keys: Object.keys(JSON.parse(JSON.stringify(level))).sort() },
  missing: { notFound: missing.error instanceof DatasetNotFoundError, message: missing.message },
  package: Object.keys(fresh).sort(),
  replaced: replaced.error instanceof DatasetReplacedError,
  served: { index: index.status, manifest: served },
}));
`;

/**
 * Typechecked, never run: every exported name used as a consumer would,
 * and the names that must stay internal refused.
 */
export const TYPES_SOURCE = `
import {
  DATASET_SCHEMA_VERSION,
  DatasetNotFoundError,
  DatasetReplacedError,
  HISTORY_SCHEMA_VERSION,
  scan,
  serve,
} from "@foundry/atlas";
import type {
  AtlasConfig,
  AtlasServer,
  DatasetManifest,
  HistoryManifest,
  PackageInternals,
  PackageReport,
  Scan,
  ScanOptions,
  ScanProgressEvent,
  ServeOptions,
  WorkspaceReport,
  WorkspaceScan,
} from "@foundry/atlas";
// @ts-expect-error The viewer lookup is internal.
import { viewerRoot } from "@foundry/atlas";
// @ts-expect-error The default port is internal.
import { DEFAULT_PORT } from "@foundry/atlas";

const kinds: string[] = [];
const options: ScanOptions = {
  history: true,
  onProgress: (event: ScanProgressEvent) => {
    kinds.push(event.kind === "history" ? \`history \${event.event.kind}\` : event.kind);
  },
  state: "./state",
};
const full: Scan = await scan(".", options);
const manifest: DatasetManifest = full.manifest;
const history: HistoryManifest | undefined = full.history?.manifest;
const internals: PackageInternals = await full.internals("@s/a");
const report: PackageReport = await full.packageReport("@s/a");
const level: WorkspaceScan = await scan.workspace(".", options);
const workspaceReport: WorkspaceReport = await level.workspaceReport();
// @ts-expect-error A workspace-level scan saves no internals.
await level.internals("@s/a");
const fresh: PackageInternals = await scan.package(".", "@s/a");
// @ts-expect-error scan.package needs a package name.
await scan.package(".");

const serveOptions: ServeOptions = { port: 0, state: "./state" };
const server: AtlasServer = await serve(".", serveOptions);
const address: string = server.url.href;
await server.stop();

type Entry = DatasetManifest["packages"][number];
const status: Entry["status"] = "complete";
// @ts-expect-error A package the scan tried is complete or failed.
const skipped: Entry["status"] = "skipped";
const dataset: 4 = DATASET_SCHEMA_VERSION;
const historySchema: 1 = HISTORY_SCHEMA_VERSION;
const caught = (error: unknown): boolean =>
  error instanceof DatasetNotFoundError || error instanceof DatasetReplacedError;

export const config = {
  domains: [{ facets: ["packages/a"], name: "core", reason: "The model." }],
  exclude: ["packages/fixtures"],
  history: { checkpoints: 6, strategy: "monthly" },
} satisfies AtlasConfig;
const domain: NonNullable<AtlasConfig["domains"]>[number] = { name: "core" };

export const used = [
  address, caught, dataset, DEFAULT_PORT, domain, fresh, history, historySchema,
  internals, kinds, manifest, report, skipped, status, viewerRoot, workspaceReport,
];
`;

/**
 * The consumer's compiler options: Node's own module rules, no ambient
 * types, and no skipLibCheck, so the shipped declarations are checked too.
 * The DOM library supplies `URL`, as `@types/node` or Bun's types would.
 */
export const TYPES_CONFIG = {
  compilerOptions: {
    lib: ["esnext", "dom"],
    module: "nodenext",
    moduleResolution: "nodenext",
    noEmit: true,
    strict: true,
    target: "esnext",
    types: [],
  },
  files: ["types.ts"],
};

/**
 * Imports the package under Node, scans the workspace in
 * `ATLAS_WORKSPACE` under the state root `ATLAS_STATE` (its workers start
 * with `bun` from the PATH), and prints the exports, the scan's coverage,
 * and what `serve` says there, as one line of JSON.
 */
export const NODE_SCRIPT = `
const atlas = await import("@foundry/atlas");
const scanned = await atlas.scan(process.env.ATLAS_WORKSPACE, {
  state: process.env.ATLAS_STATE,
});
let serve = "resolved";
try {
  await atlas.serve(".");
} catch (error) {
  serve = error.message;
}
const notFound = new atlas.DatasetNotFoundError();
const replaced = new atlas.DatasetReplacedError();
console.log(JSON.stringify({
  errors: [
    notFound instanceof Error && notFound.name,
    replaced instanceof Error && replaced.name,
  ],
  exports: Object.keys(atlas).sort(),
  scanned: scanned.manifest.coverage,
  serve,
}));
`;
