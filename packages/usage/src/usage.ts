import type { Consumption } from "./consumption";
import type { Duration } from "./limit";
import { type Reading, type Snapshot, snapshotOf } from "./snapshot";

/**
 * A credential with the name it is added under: what a provider function,
 * such as `anthropic({ name: "work", configDir })`, returns. Its reads are
 * bound to the credential, so the core never handles one.
 */
export interface Account<C = unknown> {
  /** The provider's own routing data, such as a config dir or a key. */
  readonly credential: C;
  history(since: Date): Promise<Consumption | undefined>;
  limits(): Promise<Reading>;
  readonly name: string;
  readonly provider: Provider;
}

/** What `usage` needs of a provider: its id and its default account. */
export interface Provider {
  /** The default account, named after the provider, when it looks signed in. */
  defaultAccount(): Promise<Account | undefined>;
  readonly id: string;
}

/** A span back from now, such as `"7d"`: minutes, hours, days or weeks. */
export type DurationText = `${number}${"m" | "h" | "d" | "w"}`;

export interface QueryOptions {
  /** Where consumption starts: a date, or a span back from now. Defaults to `"1d"`. */
  readonly since?: Date | DurationText;
}

export interface QueryAllOptions extends QueryOptions {
  /** Only the accounts of this provider. */
  readonly provider?: string;
}

export interface Usage {
  /** Registers it, unless its provider's id is registered, and returns its name. */
  add(account: Account): string;
  /**
   * Adds each registered provider's default account that looks signed in,
   * under the provider's id, unless that name is taken. Asks for no limits.
   * Returns the provider ids that are now added names.
   */
  initialize(): Promise<readonly string[]>;
  query(name: string, options?: QueryOptions): Promise<Snapshot>;
  query(options?: QueryAllOptions): Promise<readonly Snapshot[]>;
  use(provider: Provider): void;
}

const MINUTE: Duration = 60_000;
const UNIT_DURATIONS = new Map<string, Duration>([
  ["m", MINUTE],
  ["h", 60 * MINUTE],
  ["d", 1440 * MINUTE],
  ["w", 10_080 * MINUTE],
]);
const DURATION_TEXT = /^(\d+(?:\.\d+)?)([mhdw])$/;

const sinceDate = (since: QueryOptions["since"] = "1d"): Date => {
  if (since instanceof Date) {
    return since;
  }
  const match = DURATION_TEXT.exec(since);
  const unit = UNIT_DURATIONS.get(match?.[2] ?? "");
  if (!(match && unit)) {
    throw new Error(`Cannot read "${since}" as a duration, such as "7d".`);
  }
  return new Date(Date.now() - Number(match[1]) * unit);
};

/** Limits and consumption are independent reads; one failing never hides the other. */
const read = async (account: Account, since: Date): Promise<Snapshot> => {
  const at = new Date();
  const [limits, history] = await Promise.allSettled([
    account.limits(),
    account.history(since),
  ]);
  return snapshotOf(
    { name: account.name, provider: account.provider.id },
    at,
    limits,
    history
  );
};

/** A usage with no providers and no accounts. */
export const createUsage = (): Usage => {
  const providers = new Map<string, Provider>();
  const accounts = new Map<string, Account>();

  const add = (account: Account): string => {
    if (accounts.has(account.name)) {
      throw new Error(`A usage account named "${account.name}" is added.`);
    }
    if (!providers.has(account.provider.id)) {
      providers.set(account.provider.id, account.provider);
    }
    accounts.set(account.name, account);
    return account.name;
  };

  const query = async (
    nameOrOptions?: string | QueryAllOptions,
    named: QueryOptions = {}
  ): Promise<Snapshot | readonly Snapshot[]> => {
    if (typeof nameOrOptions === "string") {
      const account = accounts.get(nameOrOptions);
      if (!account) {
        throw new Error(`No usage account named "${nameOrOptions}" is added.`);
      }
      return read(account, sinceDate(named.since));
    }
    const { provider, since } = nameOrOptions ?? {};
    const start = sinceDate(since);
    const selected = [...accounts.values()].filter(
      (account) => (provider ?? account.provider.id) === account.provider.id
    );
    return Promise.all(selected.map((account) => read(account, start)));
  };

  return {
    add,
    initialize: async () => {
      const free = [...providers.values()].filter(
        ({ id }) => !accounts.has(id)
      );
      const found = await Promise.all(free.map((p) => p.defaultAccount()));
      for (const account of found) {
        // Checked again: a name can be taken while the providers were asked.
        if (account && !accounts.has(account.name)) {
          add(account);
        }
      }
      return [...providers.keys()].filter((id) => accounts.has(id));
    },
    query: query as Usage["query"],
    use: (provider) => {
      if (providers.has(provider.id)) {
        throw new Error(`A usage provider "${provider.id}" is registered.`);
      }
      providers.set(provider.id, provider);
    },
  };
};

/** The shared usage. */
export const usage: Usage = createUsage();
