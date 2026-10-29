/**
 * `@foundry/usage/provider`: what a provider author builds with. A consumer
 * imports `@foundry/usage` instead.
 */

import type { Consumption } from "./consumption";
import type { Reading } from "./snapshot";
import type { Account, Provider } from "./usage";

/** What a provider is made of. `O` is what its caller passes; `C` routes a read. */
interface ProviderDefinition<Id extends string, O extends object, C> {
  /** Routing data from the caller's options (without `name`), such as an absolute config dir. */
  credential(options: O): C;
  /** The default account's options when it looks signed in; presence only, no limits. */
  detect?(): Promise<NoInfer<O> | undefined>;
  /** Throw to report `errors.consumption`. Absent: no consumption. */
  history?(credential: C, since: Date): Promise<Consumption | undefined>;
  readonly id: Id;
  /** Throw to report `errors.limits`. */
  limits(credential: C): Promise<Reading>;
}

/** The options a provider function takes: its own, and the name to add under. */
type AccountOptions<O> = O & { readonly name?: string };

/** A provider function: call it for an account to add, named after the provider by default. */
interface DefinedProvider<Id extends string, O extends object, C>
  extends Provider {
  defaultAccount(): Promise<Account<C> | undefined>;
  readonly id: Id;
  (
    ...options: object extends O
      ? [options?: AccountOptions<O>]
      : [options: AccountOptions<O>]
  ): Account<C>;
}

/** A provider function from its definition. */
export const defineProvider = <Id extends string, O extends object, C>(
  definition: ProviderDefinition<Id, O, C>
): DefinedProvider<Id, O, C> => {
  const account = (options = {} as AccountOptions<O>): Account<C> => {
    const { name = definition.id, ...rest } = options;
    const credential = definition.credential(rest as O);
    return {
      credential,
      history: async (since) => definition.history?.(credential, since),
      limits: () => definition.limits(credential),
      name,
      provider,
    };
  };
  const provider = Object.assign(account, {
    defaultAccount: async () => {
      const found = await definition.detect?.();
      return found && account(found);
    },
    id: definition.id,
  }) as DefinedProvider<Id, O, C>;
  return provider;
};

export type {
  Charge,
  Consumption,
  Price,
  Quantities,
  SessionConsumption,
  Work,
} from "./consumption";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/usage/provider kit.
export { consumptionOf, listPrices, quantities } from "./consumption";
export type { Duration, Reported, ReportedLimit, Span } from "./limit";
export { balance, credits, spendCap, window } from "./limit";
export type { Identity, ProviderDetails, Reading } from "./snapshot";
export type { Account, Provider } from "./usage";
