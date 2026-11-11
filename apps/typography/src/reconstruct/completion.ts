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
import type {
  RecordedCatalogue,
  RecordedEntry,
} from "~/generation/strategies/recorded/catalogue";
import type {
  Availability,
  GenerationStrategy,
  StrategyKind,
} from "~/generation/strategies/strategy";
import { vectorModelStrategy } from "~/generation/strategies/vector-model";

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

/**
 * The runs of a catalogue that were made to complete a reconstruction: the
 * ones that say which photograph the model was shown. Runs made from a font
 * belong to the Generate place.
 */
export const photographRuns = (
  catalogue: RecordedCatalogue
): RecordedCatalogue => ({
  entries: catalogue.entries.filter(
    (entry) => entry.evidenceFile !== undefined
  ),
  problems: catalogue.problems,
});

/** How an entry reads in a list: the run and the model that made it. */
export const recordedLabel = ({ directory, output }: RecordedEntry) =>
  `${directory}: ${output.synthetic ? "synthetic sheet, no model" : output.model}`;

/**
 * Whether a recorded run answers for a photograph. A run was made by showing
 * a model one photograph, so it completes that photograph's lettering and no
 * other's. Photographs are told apart by file name: the run records no digest.
 */
export const recordedAvailability = (
  entry: RecordedEntry | undefined,
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
