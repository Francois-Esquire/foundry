/**
 * `@foundry/usage`: what a provider lets an account consume and what that
 * consumption costs, as it is when a caller queries. `usage` is the shared
 * instance; register a provider with `usage.use(provider)`. Nothing is
 * added or asked on import. The next stage registers the built-in
 * providers here with `usage.use`, each from its own `providers/<id>` folder.
 */

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
