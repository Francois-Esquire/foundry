// What a consumer of the installed package writes, as source the package
// test saves into its temporary consumer. Each imports `@foundry.sh/spyglass` by
// name, so the installed `exports` map is what resolves it.

/** The values the entry exports, sorted; nothing else is public. */
export const VALUE_EXPORTS = [
  "COLLECTION_SCHEMA_VERSION",
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
import * as spyglass from "@foundry.sh/spyglass";
import { DatasetNotFoundError, DatasetReplacedError, scan, serve } from "@foundry.sh/spyglass";

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
  collections: [typeof scan.collection, typeof serve.collection],
  exports: Object.keys(spyglass).sort(),
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
  COLLECTION_SCHEMA_VERSION,
  DATASET_SCHEMA_VERSION,
  DatasetNotFoundError,
  DatasetReplacedError,
  HISTORY_SCHEMA_VERSION,
  scan,
  serve,
} from "@foundry.sh/spyglass";
import type {
  SpyglassConfig,
  SpyglassServer,
  CollectionManifest,
  CollectionProgressEvent,
  CollectionScan,
  CollectionScanOptions,
  CollectionServer,
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
} from "@foundry.sh/spyglass";
// @ts-expect-error The viewer lookup is internal.
import { viewerRoot } from "@foundry.sh/spyglass";
// @ts-expect-error The default port is internal.
import { DEFAULT_PORT } from "@foundry.sh/spyglass";

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
const server: SpyglassServer = await serve(".", serveOptions);
const address: string = server.url.href;
await server.stop();

const workspaceKinds: string[] = [];
const collectionOptions: CollectionScanOptions = {
  history: true,
  onProgress: (event: CollectionProgressEvent) => {
    workspaceKinds.push(\`\${event.id} \${event.root} \${event.event.kind}\`);
  },
  state: "./state",
};
const collection: CollectionScan = await scan.collection(["../a", "../b"], collectionOptions);
const collectionManifest: CollectionManifest = collection.manifest;
const scans: Scan[] = collection.workspaces;
type Crossing = CollectionManifest["crossings"][number];
const crossing: Crossing | undefined = collectionManifest.crossings[0];
const collectionServer: CollectionServer = await serve.collection(["../a", "../b"], serveOptions);
const roots: string[] = collectionServer.roots;
// @ts-expect-error A collection's server has roots, not one root.
const oneRoot: string = collectionServer.root;
await collectionServer.stop();
// @ts-expect-error scan.collection takes paths, not one path.
await scan.collection("../a");
const collectionSchema: 1 = COLLECTION_SCHEMA_VERSION;

type Entry = DatasetManifest["packages"][number];
const status: Entry["status"] = "complete";
// @ts-expect-error A package the scan tried is complete or failed.
const skipped: Entry["status"] = "skipped";
const dataset: 5 = DATASET_SCHEMA_VERSION;
const historySchema: 1 = HISTORY_SCHEMA_VERSION;
const caught = (error: unknown): boolean =>
  error instanceof DatasetNotFoundError || error instanceof DatasetReplacedError;

export const config = {
  domains: [{ facets: ["packages/a"], name: "core", reason: "The model." }],
  exclude: ["packages/fixtures"],
  history: { checkpoints: 6, strategy: "monthly" },
  rules: [{ effect: "require", operator: "internalize", subject: "packages/a" }],
} satisfies SpyglassConfig;
const domain: NonNullable<SpyglassConfig["domains"]>[number] = { name: "core" };
type Rule = NonNullable<SpyglassConfig["rules"]>[number];
const rule: Rule = { effect: "permit", operator: "internalize", subject: "packages/a" };
// @ts-expect-error A rule names internalize, the one operator so far.
const moved: Rule = { effect: "permit", operator: "move", subject: "packages/a" };

export const used = [
  address, caught, collectionSchema, crossing, oneRoot, roots, scans, workspaceKinds, dataset, DEFAULT_PORT, domain, fresh, history, historySchema,
  internals, kinds, manifest, moved, report, rule, skipped, status, viewerRoot,
  workspaceReport,
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
 * `SPYGLASS_WORKSPACE` under the state root `SPYGLASS_STATE` (its workers start
 * with `bun` from the PATH), and prints the exports, the scan's coverage,
 * and what `serve` says there, as one line of JSON.
 */
export const NODE_SCRIPT = `
const spyglass = await import("@foundry.sh/spyglass");
const scanned = await spyglass.scan(process.env.SPYGLASS_WORKSPACE, {
  state: process.env.SPYGLASS_STATE,
});
let serve = "resolved";
try {
  await spyglass.serve(".");
} catch (error) {
  serve = error.message;
}
const notFound = new spyglass.DatasetNotFoundError();
const replaced = new spyglass.DatasetReplacedError();
console.log(JSON.stringify({
  errors: [
    notFound instanceof Error && notFound.name,
    replaced instanceof Error && replaced.name,
  ],
  exports: Object.keys(spyglass).sort(),
  scanned: scanned.manifest.coverage,
  serve,
}));
`;
