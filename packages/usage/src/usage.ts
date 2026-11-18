import type { Consumption } from "./consumption";
import { type Duration, resolve, type Span } from "./limit";
import {
  accountWide,
  type Reading,
  type Snapshot,
  snapshotOf,
} from "./snapshot";

export interface Account<C = unknown> {
  readonly credential: C;
  history(since: Date): Promise<Consumption | undefined>;
  limits(): Promise<Reading>;
  readonly name: string;
  readonly provider: Provider;
}

export interface Provider {
  defaultAccount(): Promise<Account | undefined>;
  readonly id: string;
}

export type DurationText = `${number}${"m" | "h" | "d" | "w"}`;

export interface QueryOptions {
  readonly since?: Date | DurationText;
}

export interface QueryAllOptions extends QueryOptions {
  readonly provider?: string;
}

export interface Usage {
  add(account: Account): string;
  initialize(): Promise<readonly Account[]>;
  query(name: string, options?: QueryOptions): Promise<Snapshot>;
  query(options?: QueryAllOptions): Promise<readonly Snapshot[]>;
  share(name: string, span?: Span): Promise<number | undefined>;
  use(provider: Provider): void;
}

const MINUTE: Duration = 60_000;
const WEEK: Duration = 10_080 * MINUTE;
const UNIT_DURATIONS = new Map<string, Duration>([
  ["m", MINUTE],
  ["h", 60 * MINUTE],
  ["d", 1440 * MINUTE],
  ["w", WEEK],
]);
const DURATION_TEXT = /^(\d+(?:\.\d+)?)([mhdw])$/;

const sinceDate = (since: QueryOptions["since"]): Date | undefined => {
  if (since === undefined || since instanceof Date) {
    return since;
  }
  const match = DURATION_TEXT.exec(since);
  const unit = UNIT_DURATIONS.get(match?.[2] ?? "");
  if (!(match && unit)) {
    throw new Error(`Cannot read "${since}" as a duration, such as "7d".`);
  }
  return new Date(Date.now() - Number(match[1]) * unit);
};

const weekStart = (reading: Reading | undefined, at: Date): Date => {
  const weekly = accountWide(reading?.limits ?? [], "weekly");
  return weekly?.resetsAt
    ? new Date(weekly.resetsAt.getTime() - weekly.duration)
    : new Date(at.getTime() - WEEK);
};

const read = async (account: Account, since?: Date): Promise<Snapshot> => {
  const at = new Date();
  const reading = account.limits();
  const [limits, history] = await Promise.allSettled([
    reading,
    since
      ? account.history(since)
      : reading
          .catch(() => undefined)
          .then((found) => account.history(weekStart(found, at))),
  ]);
  return snapshotOf(
    { name: account.name, provider: account.provider.id },
    at,
    limits,
    history
  );
};

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
        if (account && !accounts.has(account.name)) {
          add(account);
        }
      }
      return [...accounts.values()].filter((a) => a.name === a.provider.id);
    },
    query: query as Usage["query"],
    share: async (name, span = "weekly") => {
      const account = accounts.get(name);
      if (!account) {
        return;
      }
      const reading = await account.limits().catch(() => undefined);
      const limit = reading && accountWide(reading.limits, span);
      return limit && resolve(limit, new Date()).headroom.share;
    },
    use: (provider) => {
      if (providers.has(provider.id)) {
        throw new Error(`A usage provider "${provider.id}" is registered.`);
      }
      providers.set(provider.id, provider);
    },
  };
};

export const usage: Usage = createUsage();
