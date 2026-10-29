/**
 * `@foundry/usage`: what a provider lets an account consume and what that
 * consumption costs, as it is when a caller queries. `usage` is the shared
 * instance, with the built-in providers, Anthropic and OpenAI, registered;
 * register another with `usage.use(provider)`. No account is added and no
 * provider is asked anything on import.
 */

import { anthropic } from "./providers/anthropic";
import { openai } from "./providers/openai";
import { usage as shared } from "./usage";

shared.use(anthropic);
shared.use(openai);

export type {
  Charge,
  Consumption,
  Quantities,
  SessionConsumption,
} from "./consumption";
export type {
  Balance,
  CreditBalance,
  Credits,
  Duration,
  Headroom,
  Limit,
  Money,
  SpendCap,
  Window,
} from "./limit";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/usage public API.
export { exhausted, headroom, resetsIn } from "./limit";
export type {
  AccountIdentity,
  AccountUsage,
  ProviderDetails,
  Reading,
  Snapshot,
} from "./snapshot";
export type {
  Account,
  Credential,
  DurationText,
  Provider,
  QueryOptions,
  Usage,
} from "./usage";
export { usage } from "./usage";
