import type { Charge, Consumption, Quantities } from "./consumption";
import type { Duration } from "./limit";
import {
  type AccountRead,
  buildSnapshot,
  type Reading,
  type Snapshot,
} from "./snapshot";

/**
 * How a query reaches one account: a CLI login or an API key. A provider
 * extends it with what it needs to route a read, such as a config dir.
 */
export interface Credential {
  /** Stable within the provider, such as a config dir; never a secret. */
  readonly id: string;
  /** The id of the provider that reads through this credential. */
  readonly provider: string;
}

/**
 * An account added by credential. The provider's own account id is learned
 * from each query's reading, so two added accounts that reach the same
 * provider account appear as one account in a snapshot.
 */
export interface Account {
  readonly credential: Credential;
}

/** Makes credentials, reads limits and history, and may price work. */
export interface Provider {
  detect(): Promise<readonly Credential[]>;
  history(
    credential: Credential,
    since: Date
  ): Promise<Consumption | undefined>;
  readonly id: string;
  limits(credential: Credential): Promise<Reading>;
  price?(model: string, quantities: Quantities): Charge | undefined;
}

/** A span back from now, such as `"7d"`: minutes, hours, days or weeks. */
export type DurationText = `${number}${"m" | "h" | "d" | "w"}`;

export interface QueryOptions {
  readonly accounts?: readonly Account[];
  readonly provider?: string;
  /** Where consumption starts. Defaults to all history. */
  readonly since?: Date | DurationText;
}

export interface Usage {
  add(credential: Credential): Account;
  detect(): Promise<readonly Account[]>;
  query(options?: QueryOptions): Promise<Snapshot>;
  use(provider: Provider): void;
}

const MINUTE: Duration = 60_000;
const HOUR: Duration = 60 * MINUTE;
const DAY: Duration = 24 * HOUR;
const UNIT_DURATIONS = new Map<string, Duration>([
  ["m", MINUTE],
  ["h", HOUR],
  ["d", DAY],
  ["w", 7 * DAY],
]);
const DURATION_TEXT = /^(\d+(?:\.\d+)?)([mhdw])$/;

const sinceDate = (since: QueryOptions["since"], now: Date): Date => {
  if (since === undefined) {
    return new Date(0);
  }
  if (since instanceof Date) {
    return since;
  }
  const match = DURATION_TEXT.exec(since);
  const unit = UNIT_DURATIONS.get(match?.[2] ?? "");
  if (!(match && unit)) {
    throw new Error(`Cannot read "${since}" as a duration, such as "7d".`);
  }
  return new Date(now.getTime() - Number(match[1]) * unit);
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const read = async (
  provider: Provider,
  account: Account,
  since: Date
): Promise<AccountRead> => {
  const readAt = new Date();
  try {
    const [reading, consumption] = await Promise.all([
      provider.limits(account.credential),
      provider.history(account.credential, since),
    ]);
    return { account, consumption, readAt, reading };
  } catch (error) {
    return { account, failed: messageOf(error) };
  }
};

/** A usage with no providers and no accounts. */
export const createUsage = (): Usage => {
  const providers = new Map<string, Provider>();
  const accounts = new Map<string, Account>();

  const providerFor = (id: string): Provider => {
    const provider = providers.get(id);
    if (!provider) {
      throw new Error(`No usage provider "${id}" is registered.`);
    }
    return provider;
  };

  const add = (credential: Credential): Account => {
    providerFor(credential.provider);
    const key = JSON.stringify([credential.provider, credential.id]);
    const existing = accounts.get(key);
    if (existing) {
      return existing;
    }
    const account: Account = { credential };
    accounts.set(key, account);
    return account;
  };

  return {
    add,
    detect: async () => {
      const found = await Promise.all(
        [...providers.values()].map((provider) => provider.detect())
      );
      return found.flat().map(add);
    },
    query: async (options = {}) => {
      const since = sinceDate(options.since, new Date());
      const selected = [...accounts.values()].filter(
        (account) =>
          (options.accounts?.includes(account) ?? true) &&
          (options.provider ?? account.credential.provider) ===
            account.credential.provider
      );
      const reads = await Promise.all(
        selected.map((account) =>
          read(providerFor(account.credential.provider), account, since)
        )
      );
      return buildSnapshot(reads, new Date());
    },
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
