/**
 * The generation strategies the places offer, and whether each can
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

/** The clock, image encoder and provider access for live strategies. */
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

/** One offered strategy with its name, summary and availability. */
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

/** The name of a strategy recorded by a run. */
export const strategyName = (strategy: string): string =>
  strategy in NAMES ? NAMES[strategy as StrategyKind] : strategy;

/** Offers the strategies in a place's order with that place's summaries. */
export const strategyOptions = (
  means: StrategyMeans,
  recorded: Availability,
  order: readonly StrategyKind[],
  summaries: Readonly<Record<StrategyKind, string>>
): StrategyOption[] =>
  order.map((kind): StrategyOption => {
    if (kind === "recorded-run") {
      return {
        availability: recorded,
        kind,
        name: NAMES[kind],
        summary: summaries[kind],
      };
    }
    const { model, strategy } = build(kind, means, []);
    return {
      availability: strategy.availability(),
      kind,
      model,
      name: NAMES[kind],
      summary: summaries[kind],
    };
  });
