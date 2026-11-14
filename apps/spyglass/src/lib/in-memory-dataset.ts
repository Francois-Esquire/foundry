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

const UNSAFE_PATH_SEGMENT = /(^|\/)\.{0,2}(\/|$)/;

export class DatasetArtifacts implements DatasetArtifactSink {
  readonly #files: { bytes: number; file: string; reused: false }[] = [];
  readonly #texts = new Map<string, string>();

  get files(): readonly { bytes: number; file: string; reused: false }[] {
    return this.#files;
  }

  readonly read: DatasetTransport = (path) => {
    const text = this.#texts.get(path);
    return Promise.resolve(text === undefined ? undefined : JSON.parse(text));
  };

  paths(): string[] {
    return [...this.#texts.keys()];
  }

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
  beforePhase?: (name: SemanticsPhase) => Promise<void>;

  capabilities: C;

  command: string;
  discovery: DeclaredDiscovery;

  inputs?: SemanticsGenerationInputs;

  inventory: DependencyInventory;

  now?: () => Date;

  origin?: DatasetAnalysisOrigin;

  outcomes: readonly DatasetAssemblyOutcome[];

  phases?: readonly SemanticsPhaseTiming[];
  previousVisualization?: PreparedVisualization;

  root: string;
  settings: LensSettings;

  startedAt?: Date;
  workspaceName: string | undefined;
}

export interface InMemoryDataset<C> {
  capabilities: C;
  manifest: DatasetManifest;

  paths: readonly string[];
  provenance: DatasetAssemblyProvenance;

  reader(options?: DatasetReaderOptions): DatasetReader;

  text(path: string): string | undefined;

  transport: DatasetTransport;
}

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
