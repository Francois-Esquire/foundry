import type { Consumption } from "./consumption";
import type { Reading } from "./snapshot";
import type { Account, Provider } from "./usage";

interface ProviderDefinition<Id extends string, O extends object, C> {
  credential(options: O): C;
  detect?(): Promise<NoInfer<O> | undefined>;
  history?(credential: C, since: Date): Promise<Consumption | undefined>;
  readonly id: Id;
  limits(credential: C): Promise<Reading>;
}

type AccountOptions<O> = O & { readonly name?: string };

export interface DefinedProvider<Id extends string, O extends object, C>
  extends Provider {
  defaultAccount(): Promise<Account<C> | undefined>;
  readonly id: Id;
  (
    ...options: object extends O
      ? [options?: AccountOptions<O>]
      : [options: AccountOptions<O>]
  ): Account<C>;
}

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
