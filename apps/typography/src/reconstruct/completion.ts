/**
 * Completing the alphabet: the generation strategies a reconstruction can
 * ask for the characters its evidence does not show, and the recorded runs
 * that were made for a photograph. Whether a strategy can run is always the
 * strategy's own answer; nothing here swaps one for another.
 */
import type { ImageCodec } from "~/generation/raster/image-codec";
import { falImageClient } from "~/generation/strategies/fal/fal-image-client";
import { falVectorClient } from "~/generation/strategies/fal/fal-vector-client";
import { imageModelStrategy } from "~/generation/strategies/image-model";
import { proceduralStrategy } from "~/generation/strategies/procedural/procedural";
import {
  loadRecordedRuns,
  outputLabel,
  parseManifest,
  type RecordedOutput,
  type RecordedRun,
  RecordedRunError,
} from "~/generation/strategies/recorded/manifest";
import type {
  Availability,
  GenerationStrategy,
  StrategyKind,
} from "~/generation/strategies/strategy";
import { vectorModelStrategy } from "~/generation/strategies/vector-model";
import type { Fetch } from "./samples";

export type LiveStrategyKind = Exclude<StrategyKind, "recorded-run">;

export interface StrategyMeans {
  /** Says when output was produced. */
  readonly clock: () => Date;
  /** Encodes the sheet of observed letters a model is sent. */
  readonly codec: Pick<ImageCodec, "encodePng">;
  /** Replaces the network in tests. The browser's fetch when absent. */
  readonly fetch?: typeof fetch;
  /** The provider key a person pasted. Empty when there is none. */
  readonly providerKey: string;
}

interface Built {
  readonly model?: string;
  readonly strategy: GenerationStrategy;
}

const build = (
  kind: LiveStrategyKind,
  { clock, codec, fetch: send, providerKey }: StrategyMeans
): Built => {
  const key = providerKey.trim() || undefined;
  if (kind === "image-model") {
    const client = falImageClient({ fetch: send, key });
    return {
      model: client.model,
      strategy: imageModelStrategy({ client, clock, codec }),
    };
  }
  if (kind === "vector-model") {
    const client = falVectorClient({ fetch: send, key });
    return {
      model: client.model,
      strategy: vectorModelStrategy({ client, clock, codec }),
    };
  }
  return { strategy: proceduralStrategy({ clock }) };
};

export const liveStrategy = (
  kind: LiveStrategyKind,
  means: StrategyMeans
): GenerationStrategy => build(kind, means).strategy;

export interface StrategyOption {
  readonly availability: Availability;
  readonly kind: StrategyKind;
  /** The model the strategy would call, when it calls one. */
  readonly model?: string;
  readonly name: string;
  /** What the strategy does and what leaves this machine. */
  readonly summary: string;
}

const NAMES: Readonly<Record<StrategyKind, string>> = {
  "image-model": "Image model",
  procedural: "Procedural",
  "recorded-run": "Recorded run",
  "vector-model": "Vector model",
};

const SUMMARIES: Readonly<Record<StrategyKind, string>> = {
  "image-model":
    "Sends a sheet of the observed letters to an image model on fal and traces the picture it returns. A paid call, made with your key.",
  procedural:
    "Builds letters by rule from the observed ones, on this machine. It can put an accent on a letter it has. It cannot draw a letter the photograph does not show.",
  "recorded-run":
    "Replays real model output that was saved for a photograph. No model is called, and every letter is labelled as recorded.",
  "vector-model":
    "Puts a sheet of the observed letters on fal's storage, asking for it to be removed after an hour, and asks a vector model on fal to follow it. The model answers in SVG. A paid call, made with your key.",
};

const ORDER: readonly LiveStrategyKind[] = [
  "procedural",
  "vector-model",
  "image-model",
];

/** How a strategy named in a run record reads in a sentence. */
export const strategyName = (strategy: string): string =>
  strategy in NAMES ? NAMES[strategy as StrategyKind] : strategy;

/** The four strategies, each with whether it can run now and why not. */
export const strategyOptions = (
  means: StrategyMeans,
  recorded: Availability
): StrategyOption[] => {
  const [procedural, ...models] = ORDER.map((kind): StrategyOption => {
    const { model, strategy } = build(kind, means);
    return {
      availability: strategy.availability(),
      kind,
      model,
      name: NAMES[kind],
      summary: SUMMARIES[kind],
    };
  });
  return [
    ...(procedural ? [procedural] : []),
    {
      availability: recorded,
      kind: "recorded-run",
      name: NAMES["recorded-run"],
      summary: SUMMARIES["recorded-run"],
    },
    ...models,
  ];
};

/** One recorded model output that was made to complete a reconstruction. */
export interface RecordedCompletion {
  readonly createdAt: string;
  /** The directory the run's files are served from. */
  readonly directory: string;
  /** The photograph the model was shown, by file name. */
  readonly evidenceFile: string;
  readonly id: string;
  readonly manifestText: string;
  readonly output: RecordedOutput;
  /** What the run was for, in the words of whoever recorded it. */
  readonly purpose?: string;
  /** The characters the model drew, in the order of its sheet. */
  readonly targets: readonly string[];
}

export interface RecordedCompletions {
  readonly entries: readonly RecordedCompletion[];
  /** Runs that are listed but could not be read, each with the reason. */
  readonly problems: readonly string[];
}

const ROUTE = "recorded-runs";

const fetchOk = async (fetcher: Fetch, address: string): Promise<Response> => {
  const response = await fetcher(address);
  if (!response.ok) {
    throw new RecordedRunError(
      `${address} could not be fetched (${response.status}).`
    );
  }
  return response;
};

/** A run's entries, or none when its manifest does not say which photograph it was made for. */
const entriesOf = (
  directory: string,
  manifestText: string
): RecordedCompletion[] => {
  const manifest = parseManifest(manifestText);
  const evidenceFile = manifest.evidence?.file;
  if (!evidenceFile) {
    return [];
  }
  return manifest.outputs.map((output) => ({
    createdAt: manifest.createdAt,
    directory,
    evidenceFile,
    id: `${directory}#${outputLabel(output)}`,
    manifestText,
    output,
    purpose: manifest.purpose,
    targets: output.requested ?? manifest.targets ?? [],
  }));
};

/**
 * Lists the recorded runs under `base` that were made to complete a
 * reconstruction. Runs made from a font belong to the Generate place.
 */
export const listRecordedCompletions = async (
  fetcher: Fetch,
  base: string
): Promise<RecordedCompletions> => {
  const index: unknown = await (
    await fetchOk(fetcher, `${base}${ROUTE}/index.json`)
  ).json();
  const directories = Array.isArray(index)
    ? index.filter((item): item is string => typeof item === "string")
    : [];
  const entries: RecordedCompletion[] = [];
  const problems: string[] = [];
  for (const directory of directories) {
    try {
      const manifest = await fetchOk(
        fetcher,
        `${base}${ROUTE}/${directory}/run.json`
      );
      entries.push(...entriesOf(directory, await manifest.text()));
    } catch (error) {
      if (!(error instanceof RecordedRunError)) {
        throw error;
      }
      problems.push(`${directory}: ${error.message}`);
    }
  }
  return { entries, problems };
};

/** Fetches an entry's raw output and prompt and loads it for replay. */
export const loadRecordedCompletion = async (
  fetcher: Fetch,
  base: string,
  entry: RecordedCompletion
): Promise<RecordedRun> => {
  const files = new Map<string, Uint8Array>();
  const manifest = parseManifest(entry.manifestText);
  const names = new Set(
    [
      ...manifest.outputs.map((output) => output.file),
      entry.output.promptFile,
    ].filter((name) => name !== undefined)
  );
  for (const name of names) {
    const response = await fetchOk(
      fetcher,
      `${base}${ROUTE}/${entry.directory}/${name}`
    );
    files.set(name, new Uint8Array(await response.arrayBuffer()));
  }
  const run = loadRecordedRuns(entry.manifestText, files).find(
    (loaded) => outputLabel(loaded.output) === outputLabel(entry.output)
  );
  if (!run) {
    throw new RecordedRunError(
      `The recorded run ${entry.id} is no longer in its manifest.`
    );
  }
  return run;
};

/** How an entry reads in a list: the run and the model that made it. */
export const recordedLabel = ({ directory, output }: RecordedCompletion) =>
  `${directory}: ${output.synthetic ? "synthetic sheet, no model" : output.model}`;

/**
 * Whether a recorded run answers for a photograph. A run was made by showing
 * a model one photograph, so it completes that photograph's lettering and no
 * other's. Photographs are told apart by file name: the run records no digest.
 */
export const recordedAvailability = (
  entry: RecordedCompletion | undefined,
  evidenceFileName: string
): Availability => {
  if (!entry) {
    return {
      available: false,
      reason: "No recorded run was made for a photograph.",
    };
  }
  return entry.evidenceFile === evidenceFileName
    ? { available: true }
    : {
        available: false,
        reason: `This run was recorded for ${entry.evidenceFile}, not for ${evidenceFileName}. Its letters follow that photograph's lettering.`,
      };
};
