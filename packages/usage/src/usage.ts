import { type BillingAccountOptions, billingLimits } from "./billing";
import type { Consumption } from "./consumption";
import {
  compact,
  type Duration,
  resolve,
  type Span,
  spendHeadroom,
} from "./limit";
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

type RegisteredAccount = Omit<Account, "provider"> & {
  readonly provider?: Provider;
};

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

export interface Budget {
  readonly asOf: Date;
  readonly cap: number;
  readonly currency: "USD";
  readonly remaining: number;
  readonly reportedThrough?: Date;
  readonly resetsAt?: Date;
  readonly share: number;
  readonly spent: number;
  readonly startsAt?: Date;
}

export interface Usage {
  add(account: Account | BillingAccountOptions): string;
  budget(name: string): Promise<Budget | undefined>;
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

const read = async (
  account: RegisteredAccount,
  since?: Date
): Promise<Snapshot> => {
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
    { name: account.name, provider: account.provider?.id },
    at,
    limits,
    history
  );
};

const readBudget = async (
  account: RegisteredAccount
): Promise<Budget | undefined> => {
  const reading = await account.limits();
  const limit = reading.limits.find((entry) => entry.kind === "spend-cap");
  const asOf = new Date();
  if (
    !(
      limit &&
      Number.isFinite(limit.cap.amount) &&
      Number.isFinite(limit.used.amount)
    ) ||
    limit.cap.amount < 0 ||
    (limit.resetsAt && !(limit.resetsAt > asOf)) ||
    (limit.startsAt && !(limit.startsAt <= asOf))
  ) {
    return;
  }
  const { remaining, share } = spendHeadroom(limit);
  return compact<Budget>({
    asOf,
    cap: limit.cap.amount,
    currency: "USD",
    remaining,
    reportedThrough: limit.reportedThrough,
    resetsAt: limit.resetsAt,
    share: Math.min(1, share),
    spent: limit.used.amount,
    startsAt: limit.startsAt,
  });
};

export const createUsage = (): Usage => {
  const providers = new Map<string, Provider>();
  const accounts = new Map<string, RegisteredAccount>();

  const billedAccount = (options: BillingAccountOptions): RegisteredAccount => {
    const { billing, name, provider: id } = options;
    if (!Number.isFinite(billing.cap) || billing.cap < 0) {
      throw new Error(`Billing for "${name}" requires a nonnegative USD cap.`);
    }
    const account = {
      credential: undefined,
      history: async () => undefined,
      limits: () => billingLimits(options),
      name,
    };
    if (id === undefined) {
      if (typeof billing.readSpend !== "function") {
        throw new Error(`Billing for "${name}" requires a readSpend function.`);
      }
      return account;
    }
    const scope = id === "openai" ? billing.projectId : billing.workspaceId;
    if (
      typeof billing.adminKey !== "string" ||
      !billing.adminKey.trim() ||
      scope?.trim() === ""
    ) {
      throw new Error(
        `Billing for "${name}" requires an admin key and a nonempty scope ID when scoped.`
      );
    }
    return {
      ...account,
      provider: providers.get(id) ?? {
        defaultAccount: async () => undefined,
        id,
      },
    };
  };

  const add = (input: Account | BillingAccountOptions): string => {
    if (accounts.has(input.name)) {
      throw new Error(`A usage account named "${input.name}" is added.`);
    }
    const account = "limits" in input ? input : billedAccount(input);
    const { provider } = account;
    if (provider && !providers.has(provider.id)) {
      providers.set(provider.id, provider);
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
      (account) => provider === undefined || provider === account.provider?.id
    );
    return Promise.all(selected.map((account) => read(account, start)));
  };

  return {
    add,
    budget: (name) => {
      const account = accounts.get(name);
      return account
        ? readBudget(account).catch(() => undefined)
        : Promise.resolve(undefined);
    },
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
      return [...accounts.values()].filter(
        (account): account is Account => account.name === account.provider?.id
      );
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
