import { basename } from "#path";
import type {
  DatasetReader,
  DatasetReaderOptions,
  DatasetTransport,
} from "./dataset";
import { datasetReader } from "./dataset";
import type {
  DatasetAnalysis,
  DatasetAnalysisOrigin,
  DatasetAssemblyProvenance,
} from "./dataset-analysis";
import {
  DATASET_ANALYSIS_SCHEMA_VERSION,
  datasetAnalysisProblems,
  verifyDatasetAnalysis,
  verifyDatasetAnalysisCorrespondence,
} from "./dataset-analysis";
import type {
  DatasetArtifactSink,
  DatasetAssemblyOutcome,
} from "./dataset-assembly";
import { assembleDataset } from "./dataset-assembly";
import { DATASET_ANALYSIS_FILE, packageReportFile } from "./dataset-layout";
import type { DependencyInventory } from "./dependency-inventory-types";
import type { LensSettings } from "./lenses/lens-types";
import type {
  DatasetManifest,
  DeclaredDiscovery,
  SemanticsGenerationInputs,
  SemanticsPhase,
  SemanticsPhaseTiming,
} from "./semantics-types";
import type { PreparedVisualization } from "./visualization/types";

// INTERNAL: a dataset assembled in memory from analysis results, read
// through the existing `datasetReader`. The same assembly as a native scan
// (`dataset-assembly.ts`) writes into an artifact collection that this
// result owns, keyed by the dataset-relative paths a published dataset has.
// Nothing is written to a file system and nothing is fetched; no cache,
// state, lock, hardlink or swap exists here. Each result owns its own
// collection, and every read parses the stored JSON text afresh, as a file
// read would, so no reader shares or mutates another's objects. Not a
// public export.

const UNSAFE_PATH_SEGMENT = /(^|\/)\.{0,2}(\/|$)/;

/**
 * Artifacts keyed by dataset-relative path, held as the JSON text a
 * published dataset would contain. Writing a path twice is an error.
 */
export class DatasetArtifacts implements DatasetArtifactSink {
  readonly #files: { bytes: number; file: string; reused: false }[] = [];
  readonly #texts = new Map<string, string>();

  /** Every artifact written, in write order; none is reused from a previous dataset. */
  get files(): readonly { bytes: number; file: string; reused: false }[] {
    return this.#files;
  }

  /** The artifact at `path`, parsed afresh, or `undefined` when there is none. */
  readonly read: DatasetTransport = (path) => {
    const text = this.#texts.get(path);
    return Promise.resolve(text === undefined ? undefined : JSON.parse(text));
  };

  /** Dataset-relative paths, in write order. */
  paths(): string[] {
    return [...this.#texts.keys()];
  }

  /** The stored JSON text at `path`. */
  text(path: string): string | undefined {
    return this.#texts.get(path);
  }

  write(file: string, value: unknown): void {
    if (
      file === "" ||
      file.startsWith("/") ||
      file.includes("\\") ||
      UNSAFE_PATH_SEGMENT.test(file)
    ) {
      throw new Error(`Not a dataset-relative path: ${file}`);
    }
    if (this.#texts.has(file)) {
      throw new Error(`The dataset already has ${file}.`);
    }
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new Error(`${file} has no JSON value.`);
    }
    this.#texts.set(file, text);
    this.#files.push({
      bytes: new TextEncoder().encode(text).byteLength,
      file,
      reused: false,
    });
  }
}

export interface InMemoryDatasetInput<C> {
  /**
   * Awaited before each assembly phase starts; a caller yields to the event
   * loop, checks for cancellation and reports progress here. A rejection
   * stops the assembly before the phase runs.
   */
  beforePhase?: (name: SemanticsPhase) => Promise<void>;
  /**
   * What the analysis that produced the outcomes could and could not see,
   * carried unchanged on the result, and saved with the dataset when
   * `origin` is given.
   */
  capabilities: C;
  /** Recorded as the manifest's generation command. */
  command: string;
  discovery: DeclaredDiscovery;
  /** The inputs fingerprint, when the caller computed one. */
  inputs?: SemanticsGenerationInputs;
  /** The workspace's dependency inventory with its resolved graph, before usage enrichment. */
  inventory: DependencyInventory;
  /** The clock read for the manifest's `finishedAt`. Default: `new Date()`. */
  now?: () => Date;
  /**
   * Where the analysed sources came from. When given, the capabilities,
   * this origin and the provenance are saved at `DATASET_ANALYSIS_FILE`,
   * checked against the analysis metadata schema and this input (its root
   * and command; see `datasetAnalysisProblems`) before they are written,
   * checked again against the assembled manifest, and answered by the
   * reader's `analysis()` after a reload.
   */
  origin?: DatasetAnalysisOrigin;
  /** In discovery order, one per unit; a unit with a report has a local report. */
  outcomes: readonly DatasetAssemblyOutcome[];
  /** Phases timed before assembly, such as preparation and analysis. */
  phases?: readonly SemanticsPhaseTiming[];
  previousVisualization?: PreparedVisualization;
  /** The workspace root; the manifest records its last segment. */
  root: string;
  settings: LensSettings;
  /**
   * When the operation that produced the outcomes started, so the
   * manifest's `startedAt` and `totalDurationMs` cover preparation and
   * analysis as well as assembly. Default: read from `now` when assembly
   * starts.
   */
  startedAt?: Date;
  workspaceName: string | undefined;
}

export interface InMemoryDataset<C> {
  capabilities: C;
  manifest: DatasetManifest;
  /** Dataset-relative paths of every artifact, in write order. */
  paths: readonly string[];
  provenance: DatasetAssemblyProvenance;
  /** A new reader of this dataset; one reader is one read, as for a saved dataset. */
  reader(options?: DatasetReaderOptions): DatasetReader;
  /** The stored JSON text of one artifact, as a published file would hold it. */
  text(path: string): string | undefined;
  /** Answers parsed JSON for this dataset's paths, `undefined` for any other. */
  transport: DatasetTransport;
}

/**
 * Assembles every artifact of a dataset from analysis results, in memory,
 * with the native scan's assembly and order: package reports, then
 * `assembleDataset`'s artifacts ending with the manifest.
 */
export async function assembleInMemoryDataset<C>(
  input: InMemoryDatasetInput<C>
): Promise<InMemoryDataset<C>> {
  const artifacts = new DatasetArtifacts();
  const phases: SemanticsPhaseTiming[] = [...(input.phases ?? [])];
  const startedAt = input.startedAt ?? input.now?.() ?? new Date();
  const provenance: DatasetAssemblyProvenance = {
    inputsFingerprint: input.inputs === undefined ? "unrecorded" : "recorded",
    internals: "not-assembled",
  };
  for (const outcome of input.outcomes) {
    if (outcome.report !== undefined) {
      artifacts.write(packageReportFile(outcome.unit.id), outcome.report);
    }
  }
  const analysis =
    input.origin === undefined
      ? undefined
      : analysisFor(input, input.origin, provenance);
  if (analysis !== undefined) {
    artifacts.write(DATASET_ANALYSIS_FILE, analysis);
  }
  const { beforePhase } = input;
  const { manifest } = await assembleDataset(
    {
      command: input.command,
      concurrency: 1,
      derived: true,
      discovery: input.discovery,
      ...(input.inputs !== undefined && { inputs: input.inputs }),
      inventory: () => input.inventory,
      mode: "full",
      ...(input.now !== undefined && { now: input.now }),
      outcomes: input.outcomes,
      packagesAnalyzed: input.outcomes.filter((o) => o.local !== undefined)
        .length,
      packagesReused: 0,
      phase: async (name, run) => {
        await beforePhase?.(name);
        const at = performance.now();
        try {
          return await run();
        } finally {
          phases.push({ durationMs: Math.round(performance.now() - at), name });
        }
      },
      phases,
      ...(input.previousVisualization !== undefined && {
        previousVisualization: () =>
          Promise.resolve(input.previousVisualization),
      }),
      root: input.root,
      settings: input.settings,
      startedAt,
      workspaceName: input.workspaceName,
    },
    artifacts
  );
  if (analysis !== undefined) {
    // The saved manifest, not only the inputs, agrees with the metadata.
    verifyDatasetAnalysisCorrespondence(analysis, manifest);
  }
  const transport = artifacts.read;
  return {
    capabilities: input.capabilities,
    manifest: structuredClone(manifest),
    paths: artifacts.paths(),
    provenance,
    reader: (options) => datasetReader(transport, options),
    text: (path) => artifacts.text(path),
    transport,
  };
}

/**
 * The metadata to save, checked against the metadata schema and against the
 * assembly's actual inputs (its root, command, fingerprint and the internals
 * it never assembles) before anything is written.
 */
function analysisFor<C>(
  input: InMemoryDatasetInput<C>,
  origin: DatasetAnalysisOrigin,
  provenance: DatasetAssemblyProvenance
): DatasetAnalysis {
  const analysis = verifyDatasetAnalysis({
    capabilities: input.capabilities,
    origin,
    provenance,
    schemaVersion: DATASET_ANALYSIS_SCHEMA_VERSION,
  });
  const problems = [
    ...(origin.root === input.root
      ? []
      : [
          `origin.root ${JSON.stringify(origin.root)} is not the assembly root ${JSON.stringify(input.root)}`,
        ]),
    ...datasetAnalysisProblems(analysis, {
      generation: { command: input.command, inputs: input.inputs },
      packages: [],
      workspace: { root: basename(input.root) },
    }),
  ];
  if (problems.length > 0) {
    throw new Error(
      `The analysis metadata contradicts the assembly inputs: ${problems.join("; ")}.`
    );
  }
  return analysis;
}
