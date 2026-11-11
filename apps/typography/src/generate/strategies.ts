/**
 * The generation strategies the Generate place offers, and whether each can
 * run now. Whether a strategy is available is always the strategy's own
 * answer; nothing here swaps one strategy for another.
 */
import type { ImageCodec } from "~/generation/raster/image-codec";
import { falImageClient } from "~/generation/strategies/fal/fal-image-client";
import { falVectorClient } from "~/generation/strategies/fal/fal-vector-client";
import { imageModelStrategy } from "~/generation/strategies/image-model";
import { proceduralStrategy } from "~/generation/strategies/procedural/procedural";
import type {
  Availability,
  GenerationStrategy,
  StrategyKind,
} from "~/generation/strategies/strategy";
import { vectorModelStrategy } from "~/generation/strategies/vector-model";

/** A strategy that draws now, as opposed to replaying a recorded run. */
export type LiveStrategyKind = Exclude<StrategyKind, "recorded-run">;

export interface StrategyMeans {
  /** Says when output was produced. */
  readonly clock: () => Date;
  /** Encodes the style reference sheet a model is sent. */
  readonly codec: Pick<ImageCodec, "encodePng">;
  /** Replaces the network in tests. The browser's fetch when absent. */
  readonly fetch?: typeof fetch;
  /** The provider key a person pasted. Empty when there is none. */
  readonly providerKey: string;
}

interface Built {
  /** The model the strategy would call, as the provider names it. */
  readonly model?: string;
  readonly strategy: GenerationStrategy;
}

const build = (
  kind: LiveStrategyKind,
  { clock, codec, fetch: send, providerKey }: StrategyMeans,
  heldOut: readonly number[]
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
  return { strategy: proceduralStrategy({ clock, exclude: heldOut }) };
};

/**
 * Builds a live strategy. `heldOut` names the characters under a holdout
 * test, which the procedural strategy must not read from the face.
 */
export const liveStrategy = (
  kind: LiveStrategyKind,
  means: StrategyMeans,
  heldOut: readonly number[] = []
): GenerationStrategy => build(kind, means, heldOut).strategy;

export interface StrategyOption {
  readonly availability: Availability;
  readonly kind: StrategyKind;
  /** The model the strategy would call, when it calls one. */
  readonly model?: string;
  readonly name: string;
  /** What the strategy does and what leaves this machine, in a sentence or two. */
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
    "Sends the style reference sheet to an image model on fal and traces the picture it returns. A paid call, made with your key.",
  procedural:
    "Builds accented letters from a base letter and its marks, by rule, on this machine. No model is called and nothing leaves it.",
  "recorded-run":
    "Replays real model output that was saved earlier. No model is called, and every candidate is labelled as recorded.",
  "vector-model":
    "Puts the style reference sheet on fal's storage, asking for it to be removed after an hour, and asks a vector model on fal to follow it. The model answers in SVG, so glyphs keep its own curves. A paid call, made with your key.",
};

/** The name a strategy goes by in provenance, in words for a label. */
export const strategyLabel = (strategy: string): string => {
  if (strategy === "synthetic-sheet") {
    return "Synthetic sheet, no model";
  }
  return strategy in NAMES ? NAMES[strategy as StrategyKind] : strategy;
};

const LIVE: readonly LiveStrategyKind[] = [
  "procedural",
  "image-model",
  "vector-model",
];

/**
 * The four strategies in the order they are offered. `recorded` is whether a
 * recorded run can be replayed now, which depends on the served runs and is
 * decided by the caller.
 */
export const strategyOptions = (
  means: StrategyMeans,
  recorded: Availability
): StrategyOption[] => [
  ...LIVE.map((kind): StrategyOption => {
    const { model, strategy } = build(kind, means, []);
    return {
      availability: strategy.availability(),
      kind,
      model,
      name: NAMES[kind],
      summary: SUMMARIES[kind],
    };
  }),
  {
    availability: recorded,
    kind: "recorded-run",
    name: NAMES["recorded-run"],
    summary: SUMMARIES["recorded-run"],
  },
];
