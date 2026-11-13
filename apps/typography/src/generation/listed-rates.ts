/**
 * Prices the providers listed for the models this app has strategies for,
 * as read on the day named. They are inputs to an estimate, not quotes.
 * Each price and unit is what fal's pricing service answered for that
 * endpoint on the named date, in US dollars. For the two models priced per
 * "unit", fal did not say how many units one call takes, so their estimates
 * give no dollar figure.
 */
import type { ListedRate } from "./cost";

const READ_ON = "2026-11-10";

export const LISTED_RATES: readonly ListedRate[] = [
  {
    listedOn: READ_ON,
    model: "openai/gpt-image-2.6/flare/edit",
    per: "unit",
    usd: 1,
  },
  {
    listedOn: READ_ON,
    model: "fal-ai/recraft/v4.1/text-to-vector",
    per: "image",
    usd: 0.08,
  },
  {
    listedOn: READ_ON,
    model: "ideogram/vector/text-to-vector",
    per: "unit",
    usd: 0.01,
  },
];

/** The listed rate of a model, by the name its provider gives it. */
export const listedRateFor = (model: string): ListedRate | undefined =>
  LISTED_RATES.find((rate) => rate.model === model);
