import {
  DATASET_FILES,
  HISTORY_DIRECTORY,
  HISTORY_FILES,
} from "./dataset-layout";
import type { PackageInternals } from "./internal-analysis-types";
import { verifyInternals } from "./internal-analysis-types";
import type { LensId, LensOutputs } from "./lenses/lens-types";
import { LENS_SCHEMA_VERSIONS } from "./lenses/lens-types";
import type {
  HistoryManifest,
  SemanticsHistoryEntities,
} from "./semantics-history-types";
import { HISTORY_SCHEMA_VERSION } from "./semantics-history-types";
import type {
  DatasetManifest,
  SemanticsManifestPackage,
  SemanticsModuleEdgeShard,
  SemanticsModuleIndex,
  SemanticsModuleShard,
} from "./semantics-types";
import { DATASET_SCHEMA_VERSION } from "./semantics-types";
import type { SurfaceReport } from "./types";
import type { WorkspaceGraphProjection } from "./workspace-projection-types";
import type { WorkspaceReport } from "./workspace-types";

/**
 * Reads one dataset file by its dataset-relative path: its parsed JSON, or
 * `undefined` when the dataset has no such file. Throws on any other failure.
 * `fetch` serves the viewer and the file system serves Node.
 */
export type DatasetTransport = (path: string) => Promise<unknown>;

/** The dataset's analysis of one package. */
export type PackageReport = SurfaceReport;

export interface DatasetReaderOptions {
  /**
   * The manifest's `generatedAt` the caller already holds. A manifest saved
   * at another time means a later scan replaced the dataset, and the read
   * fails with `DatasetReplacedError`.
   */
  pin?: string;
}

/** A dataset's history: its manifest and the entities it names. */
interface DatasetHistory {
  entities: SemanticsHistoryEntities;
  manifest: HistoryManifest;
}

/**
 * One read of one dataset. The manifest is read once, checked against the
 * schema version (and the pin, when given), and kept, so one reader is one
 * read: create one per read to see a later scan. History's manifest is found
 * by its fixed path; every other file through what the manifest records.
 * `packageReport`, `internals`, and `lens` read the manifest plus one file,
 * never a shard.
 */
export interface DatasetReader {
  dependencyGraph(): Promise<WorkspaceGraphProjection>;
  /** `undefined` when the scan did not include history. */
  history(): Promise<DatasetHistory | undefined>;
  internals(name: string): Promise<PackageInternals>;
  /** One lens's output, at the schema version this Atlas reads. */
  lens<I extends LensId>(id: I): Promise<LensOutputs[I]>;
  manifest(): Promise<DatasetManifest>;
  moduleEdgeShards(): Promise<SemanticsModuleEdgeShard[]>;
  moduleIndex(): Promise<SemanticsModuleIndex>;
  moduleShards(): Promise<SemanticsModuleShard[]>;
  packageReport(name: string): Promise<PackageReport>;
  workspaceReport(): Promise<WorkspaceReport>;
}

/** There is no manifest where the dataset should be. */
export class DatasetNotFoundError extends Error {
  /** `message` names where the dataset was looked for, when the caller knows. */
  constructor(
    message = "No dataset found. Run atlas scan to save one.",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DatasetNotFoundError";
  }
}

/** The manifest is not the one the reader was pinned to. */
export class DatasetReplacedError extends Error {
  constructor() {
    super(
      "A later scan replaced this dataset. Scan again to read the new one."
    );
    this.name = "DatasetReplacedError";
  }
}

const HISTORY_MANIFEST = `${HISTORY_DIRECTORY}/${HISTORY_FILES.manifest}`;

export function datasetReader(
  read: DatasetTransport,
  options: DatasetReaderOptions = {}
): DatasetReader {
  let manifest: Promise<DatasetManifest> | undefined;
  let index: Promise<SemanticsModuleIndex> | undefined;
  let history: Promise<DatasetHistory | undefined> | undefined;
  const readManifest = (): Promise<DatasetManifest> => {
    manifest ??= checkedManifest(read, options.pin);
    return manifest;
  };
  /** One file the manifest names, read once the manifest is checked. */
  const fromManifest = async <T>(
    pick: (saved: DatasetManifest) => string
  ): Promise<T> => required<T>(read, pick(await readManifest()));
  const readIndex = (): Promise<SemanticsModuleIndex> => {
    index ??= fromManifest((saved) => saved.files.moduleIndex);
    return index;
  };
  const shards = async <T>(
    pick: (saved: SemanticsModuleIndex) => { file: string }[]
  ): Promise<T[]> =>
    Promise.all(
      pick(await readIndex()).map(({ file }) => required<T>(read, file))
    );
  return {
    dependencyGraph: () =>
      fromManifest((saved) => saved.files.projections.dependencyGraph),
    history: () => {
      history ??= readManifest().then(() => readHistory(read));
      return history;
    },
    internals: async (name) =>
      verifyInternals(
        await fromManifest((saved) => internalsPath(packageEntry(saved, name))),
        name
      ),
    lens: (id) => fromManifest((saved) => lensPath(saved, id)),
    manifest: readManifest,
    moduleEdgeShards: () => shards((saved) => saved.edgeShards),
    moduleIndex: readIndex,
    moduleShards: () => shards((saved) => saved.shards),
    packageReport: (name) =>
      fromManifest((saved) => reportPath(packageEntry(saved, name))),
    workspaceReport: () => fromManifest((saved) => saved.files.workspace),
  };
}

async function required<T>(read: DatasetTransport, path: string): Promise<T> {
  const value = await read(path);
  if (value === undefined) {
    throw new Error(`The dataset is missing ${path}. Run atlas scan again.`);
  }
  return value as T;
}

async function checkedManifest(
  read: DatasetTransport,
  pin: string | undefined
): Promise<DatasetManifest> {
  const manifest = await read(DATASET_FILES.manifest);
  if (manifest === undefined) {
    throw new DatasetNotFoundError();
  }
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error(
      "The dataset's manifest is unreadable. Run atlas scan again."
    );
  }
  const { generatedAt, schemaVersion } = manifest as DatasetManifest;
  if (schemaVersion !== DATASET_SCHEMA_VERSION) {
    throw new Error(
      `Atlas reads dataset schema version ${DATASET_SCHEMA_VERSION}; this dataset has version ${schemaVersion}. Run atlas scan to save it again.`
    );
  }
  if (pin !== undefined && generatedAt !== pin) {
    throw new DatasetReplacedError();
  }
  return manifest as DatasetManifest;
}

async function readHistory(
  read: DatasetTransport
): Promise<DatasetHistory | undefined> {
  const manifest = (await read(HISTORY_MANIFEST)) as
    | HistoryManifest
    | undefined;
  if (manifest === undefined) {
    return;
  }
  if (manifest.schemaVersion !== HISTORY_SCHEMA_VERSION) {
    throw new Error(
      `Atlas reads history schema version ${HISTORY_SCHEMA_VERSION}; this dataset's history has version ${manifest.schemaVersion}. Run atlas scan --history to save it again.`
    );
  }
  const entities = await required<SemanticsHistoryEntities>(
    read,
    `${HISTORY_DIRECTORY}/${manifest.files.entities}`
  );
  return { entities, manifest };
}

function packageEntry(
  manifest: DatasetManifest,
  name: string
): SemanticsManifestPackage {
  const found = manifest.packages.find((pkg) => pkg.id === name);
  if (found === undefined) {
    const names = manifest.packages.map((pkg) => pkg.id);
    throw new Error(
      `The dataset has no package named ${name}. ${
        names.length === 0
          ? "It has no packages."
          : `Its packages: ${names.join(", ")}.`
      }`
    );
  }
  return found;
}

function reportPath(pkg: SemanticsManifestPackage): string {
  if (pkg.status === "failed") {
    throw new Error(
      `Atlas could not analyze ${pkg.id}, so it has no package report.`
    );
  }
  if (pkg.report === undefined) {
    throw new Error(
      `The dataset has no package report for ${pkg.id}. Run atlas scan again.`
    );
  }
  return pkg.report;
}

function lensPath(manifest: DatasetManifest, id: LensId): string {
  const entry = manifest.lenses[id];
  if (entry === undefined) {
    throw new Error(`The dataset has no ${id} lens. Run atlas scan again.`);
  }
  const expected = LENS_SCHEMA_VERSIONS[id];
  if (entry.schemaVersion !== expected) {
    throw new Error(
      `Atlas reads ${id} lens schema version ${expected}; this dataset's ${id} lens has version ${entry.schemaVersion}. Run atlas scan to save it again.`
    );
  }
  return entry.file;
}

function internalsPath(pkg: SemanticsManifestPackage): string {
  if (pkg.status === "failed") {
    throw new Error(
      `Atlas could not analyze ${pkg.id}, so it has no internals.`
    );
  }
  if (pkg.internals === undefined) {
    throw new Error(
      `The dataset was saved without internals for ${pkg.id}. Run atlas scan to include them.`
    );
  }
  return pkg.internals;
}
