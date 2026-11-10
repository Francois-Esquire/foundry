/**
 * What a generation run is expected to cost, worked out before it starts so
 * the interface can show it. An estimate from a provider's listed rate, with
 * every assumption behind it in words. It is never the charge: the provider's
 * bill is.
 */
import type { StrategyKind } from "../strategies/strategy";

/** A provider's published price for one model. */
export interface ListedRate {
  /** The day the price was read, as an ISO date. Prices change. */
  readonly listedOn: string;
  /** The model as the provider names it. */
  readonly model: string;
  /**
   * What the price is for. An image is one call's sheet. A unit is the
   * provider's own measure, and only some providers say how many a call takes.
   */
  readonly per: "image" | "unit";
  /** Units one call takes, when the provider publishes it. */
  readonly unitsPerCall?: number;
  /** US dollars for one image or one unit. */
  readonly usd: number;
}

export interface CostQuestion {
  /** How many faces the run generates for. */
  readonly faces: number;
  /**
   * How many glyphs one call draws. One when absent, which is the dearest
   * case. A sheet strategy draws every target of a face in one call.
   */
  readonly glyphsPerCall?: number;
  readonly kind: StrategyKind;
  /** The listed rate of the model behind the strategy, when one is known. */
  readonly rate?: ListedRate;
  /** How many glyphs each face is asked for. */
  readonly targets: number;
}

export interface CostEstimate {
  /** Everything the figure rests on, each as a sentence. */
  readonly assumptions: readonly string[];
  /** Calls to a model. Zero for strategies that call none. */
  readonly calls: number;
  /** In US dollars. Absent when the listed rate does not settle a figure. */
  readonly usd?: number;
}

const CENTS = 100;
const MICRO = 1_000_000;

const count = (amount: number, noun: string) =>
  `${amount} ${noun}${amount === 1 ? "" : "s"}`;

const whole = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

/** Dollars without float noise, to the cent where that loses nothing. */
const dollars = (usd: number) => {
  const exact = Math.round(usd * MICRO) / MICRO;
  const cents = Math.round(exact * CENTS) / CENTS;
  return `${cents === exact ? exact.toFixed(2) : exact} dollars`;
};

const FREE: Readonly<
  Record<Exclude<StrategyKind, "image-model" | "vector-model">, string>
> = {
  procedural:
    "The procedural strategy runs on this machine and calls no model, so it costs nothing.",
  "recorded-run":
    "A recorded run is replayed from saved output and calls no model, so it costs nothing now. The original calls were paid for when they were made.",
};

const priced = (
  calls: number,
  rate: ListedRate
): { readonly assumptions: string[]; readonly usd?: number } => {
  const listed = `The listed rate for ${rate.model} is ${dollars(rate.usd)} per ${rate.per}, read on ${rate.listedOn}. The price may have changed since.`;
  if (rate.per === "image") {
    return {
      assumptions: [listed, "Each call returns one image."],
      usd: calls * rate.usd,
    };
  }
  if (rate.unitsPerCall === undefined) {
    return {
      assumptions: [
        listed,
        "The provider does not publish how many units a call takes, so no dollar figure can be given. Run one call and read the charge on the provider's dashboard.",
      ],
    };
  }
  return {
    assumptions: [
      listed,
      `Each call takes ${count(rate.unitsPerCall, "unit")}.`,
    ],
    usd: calls * rate.unitsPerCall * rate.usd,
  };
};

/**
 * Estimates a run: calls are faces times the calls one face needs, and the
 * cost is calls times the listed rate.
 */
export const estimateCost = (question: CostQuestion): CostEstimate => {
  if (question.kind === "procedural" || question.kind === "recorded-run") {
    return { assumptions: [FREE[question.kind]], calls: 0, usd: 0 };
  }
  const faces = whole(question.faces);
  const targets = whole(question.targets);
  const perCall = Math.max(1, whole(question.glyphsPerCall ?? 1));
  const callsPerFace = Math.ceil(targets / perCall);
  const calls = faces * callsPerFace;
  const batching =
    perCall === 1
      ? `Each call draws one glyph: ${count(targets, "glyph")} for each of ${count(faces, "face")} is ${count(calls, "call")}.`
      : `Each call draws a sheet of up to ${count(perCall, "glyph")}: ${count(callsPerFace, "call")} for each of ${count(faces, "face")} is ${count(calls, "call")}.`;
  const repeats =
    "No call is repeated. A sheet that fails or is asked for again costs the same again.";
  if (!question.rate) {
    return {
      assumptions: [
        batching,
        repeats,
        "No listed rate is known for this model, so no dollar figure can be given.",
      ],
      calls,
    };
  }
  const { assumptions, usd } = priced(calls, question.rate);
  return {
    assumptions: [
      batching,
      ...assumptions,
      repeats,
      "This is an estimate from the listed rate. The provider's bill is the real figure.",
    ],
    calls,
    ...(usd === undefined ? {} : { usd: Math.round(usd * MICRO) / MICRO }),
  };
};
