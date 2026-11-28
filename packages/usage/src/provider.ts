import type { Consumption } from "./consumption";
import type { Reading } from "./snapshot";
import type { Account, AccountCallOptions, Provider } from "./usage";

interface ProviderDefinition<Id extends string, O extends object, C> {
  credential(options: O): C;
  detect?(): Promise<NoInfer<O> | undefined>;
  history?(
    credential: C,
    since: Date,
    options?: AccountCallOptions
  ): Promise<Consumption | undefined>;
  readonly id: Id;
  limits(credential: C, options?: AccountCallOptions): Promise<Reading>;
}

type AccountOptions<O> = O & { readonly name?: string };

export interface DefinedProvider<Id extends string, O extends object>
  extends Provider {
  defaultAccount(): Promise<Account | undefined>;
  readonly id: Id;
  (
    ...options: object extends O
      ? [options?: AccountOptions<O>]
      : [options: AccountOptions<O>]
  ): Account;
}

export const defineProvider = <Id extends string, O extends object, C>(
  definition: ProviderDefinition<Id, O, C>
): DefinedProvider<Id, O> => {
  const account = (options = {} as AccountOptions<O>): Account => {
    const { name = definition.id, ...rest } = options;
    const credential = definition.credential(rest as O);
    return {
      history: async (since, callOptions) =>
        definition.history?.(credential, since, callOptions),
      limits: (callOptions) => definition.limits(credential, callOptions),
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
  }) as DefinedProvider<Id, O>;
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
export type { Account, AccountCallOptions, Provider } from "./usage";
