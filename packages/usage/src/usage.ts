import {
  type BillingAccountOptions,
  type BillingReadRuntime,
  billingLimits,
  validateBillingBaseUrl,
} from "./billing-account";
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

export interface AccountCallOptions {
  readonly signal?: AbortSignal;
}

export interface Account {
  history(
    since: Date,
    options?: AccountCallOptions
  ): Promise<Consumption | undefined>;
  limits(options?: AccountCallOptions): Promise<Reading>;
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
  readonly history?: boolean;
  readonly signal?: AbortSignal;
  readonly since?: Date | DurationText;
}

export interface QueryAllOptions extends QueryOptions {
  readonly provider?: string;
}

export interface UsageOptions {
  readonly billingTimeoutMs?: number;
  readonly clock?: () => Date;
  readonly concurrency?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxBillingPages?: number;
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
  budget(
    name: string,
    options?: AccountCallOptions
  ): Promise<Budget | undefined>;
  initialize(): Promise<readonly Account[]>;
  query(name: string, options?: QueryOptions): Promise<Snapshot>;
  query(options?: QueryAllOptions): Promise<readonly Snapshot[]>;
  queryAccount(
    account: Account | BillingAccountOptions,
    options?: QueryOptions
  ): Promise<Snapshot>;
  remove(name: string): boolean;
  share(
    name: string,
    span?: Span,
    options?: AccountCallOptions
  ): Promise<number | undefined>;
  use(provider: Provider): void;
}

const MINUTE: Duration = 60_000;
const WEEK: Duration = 10_080 * MINUTE;
const DEFAULT_CONCURRENCY = 8;
const UNIT_DURATIONS = new Map<string, Duration>([
  ["m", MINUTE],
  ["h", 60 * MINUTE],
  ["d", 1440 * MINUTE],
  ["w", WEEK],
]);
const DURATION_TEXT = /^(\d+(?:\.\d+)?)([mhdw])$/;

const sinceDate = (
  since: QueryOptions["since"],
  clock: () => Date
): Date | undefined => {
  if (since === undefined || since instanceof Date) {
    return since;
  }
  const match = DURATION_TEXT.exec(since);
  const unit = UNIT_DURATIONS.get(match?.[2] ?? "");
  if (!(match && unit)) {
    throw new Error(`Cannot read "${since}" as a duration, such as "7d".`);
  }
  return new Date(clock().getTime() - Number(match[1]) * unit);
};

const weekStart = (reading: Reading | undefined, at: Date): Date => {
  const weekly = accountWide(reading?.limits ?? [], "weekly");
  return weekly?.resetsAt
    ? new Date(weekly.resetsAt.getTime() - weekly.duration)
    : new Date(at.getTime() - WEEK);
};

export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> => {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Concurrency limit must be a positive integer.");
  }
  if (items.length === 0) {
    return [];
  }
  const workers = Math.min(items.length, limit);
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const run = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await mapper(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
  return results;
};

const read = async (
  account: RegisteredAccount,
  options: {
    readonly clock: () => Date;
    readonly history: boolean;
    readonly signal?: AbortSignal;
    readonly since?: Date;
  }
): Promise<Snapshot> => {
  const { clock, history: includeHistory, signal, since } = options;
  signal?.throwIfAborted();
  const at = clock();
  const callOptions = signal ? { signal } : undefined;
  const reading = account.limits(callOptions);
  let historyPromise: Promise<Consumption | undefined>;
  if (!includeHistory) {
    historyPromise = Promise.resolve(undefined);
  } else if (since) {
    historyPromise = account.history(since, callOptions);
  } else {
    historyPromise = reading
      .catch(() => undefined)
      .then((found) => {
        signal?.throwIfAborted();
        return account.history(weekStart(found, at), callOptions);
      });
  }
  const [limits, history] = await Promise.allSettled([reading, historyPromise]);
  signal?.throwIfAborted();
  return snapshotOf(
    { name: account.name, provider: account.provider?.id },
    at,
    limits,
    history
  );
};

const readBudget = async (
  account: RegisteredAccount,
  clock: () => Date,
  options?: AccountCallOptions
): Promise<Budget | undefined> => {
  options?.signal?.throwIfAborted();
  const reading = await account.limits(options);
  options?.signal?.throwIfAborted();
  const limit = reading.limits.find((entry) => entry.kind === "spend-cap");
  const asOf = clock();
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

const validateUsageOptions = (options: UsageOptions): void => {
  if (
    options.concurrency !== undefined &&
    (!Number.isInteger(options.concurrency) || options.concurrency < 1)
  ) {
    throw new RangeError(
      "Usage option `concurrency` must be a finite integer >= 1."
    );
  }
  if (
    options.maxBillingPages !== undefined &&
    (!Number.isInteger(options.maxBillingPages) || options.maxBillingPages < 1)
  ) {
    throw new RangeError(
      "Usage option `maxBillingPages` must be a finite integer >= 1."
    );
  }
  if (
    options.billingTimeoutMs !== undefined &&
    (!Number.isFinite(options.billingTimeoutMs) ||
      options.billingTimeoutMs <= 0)
  ) {
    throw new RangeError(
      "Usage option `billingTimeoutMs` must be a finite number > 0."
    );
  }
};

export const createUsage = (options: UsageOptions = {}): Usage => {
  validateUsageOptions(options);
  const clock = options.clock ?? (() => new Date());
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const billingBaseRuntime: BillingReadRuntime = {
    billingTimeoutMs: options.billingTimeoutMs,
    clock,
    fetch: options.fetch,
    maxBillingPages: options.maxBillingPages,
  };
  const providers = new Map<string, Provider>();
  const stubProviders = new Set<string>();
  const accounts = new Map<string, RegisteredAccount>();

  const billedAccount = (input: BillingAccountOptions): RegisteredAccount => {
    const { billing, name, provider: id } = input;
    if (!Number.isFinite(billing.cap) || billing.cap < 0) {
      throw new Error(`Billing for "${name}" requires a nonnegative USD cap.`);
    }
    const account = {
      history: async () => undefined,
      limits: (callOptions?: AccountCallOptions) =>
        billingLimits(input, {
          ...billingBaseRuntime,
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        }),
      name,
    };
    if (id === undefined) {
      if (typeof billing.readSpend !== "function") {
        throw new Error(`Billing for "${name}" requires a readSpend function.`);
      }
      return account;
    }
    if (billing.baseUrl !== undefined) {
      validateBillingBaseUrl(billing.baseUrl);
    }
    const scope = id === "openai" ? billing.projectId : billing.workspaceId;
    const validKey =
      typeof billing.adminKey === "function" ||
      (typeof billing.adminKey === "string" &&
        Boolean(billing.adminKey.trim()));
    if (!validKey || scope?.trim() === "") {
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

  const toRegistered = (
    input: Account | BillingAccountOptions
  ): RegisteredAccount => ("limits" in input ? input : billedAccount(input));

  const rebindProvider = (provider: Provider): void => {
    for (const [accountName, existing] of accounts.entries()) {
      if (existing.provider?.id === provider.id) {
        accounts.set(accountName, { ...existing, provider });
      }
    }
  };

  const add = (input: Account | BillingAccountOptions): string => {
    if (accounts.has(input.name)) {
      throw new Error(`A usage account named "${input.name}" is added.`);
    }
    const isDirectAccount = "limits" in input;
    const account = isDirectAccount ? input : billedAccount(input);
    const { provider } = account;
    if (provider) {
      if (!providers.has(provider.id)) {
        providers.set(provider.id, provider);
        if (!isDirectAccount) {
          stubProviders.add(provider.id);
        }
      } else if (isDirectAccount && stubProviders.has(provider.id)) {
        providers.set(provider.id, provider);
        stubProviders.delete(provider.id);
        rebindProvider(provider);
      }
    }
    accounts.set(account.name, account);
    return account.name;
  };

  const query = async (
    nameOrOptions?: string | QueryAllOptions,
    named: QueryOptions = {}
  ): Promise<Snapshot | readonly Snapshot[]> => {
    if (typeof nameOrOptions === "string") {
      named.signal?.throwIfAborted();
      const account = accounts.get(nameOrOptions);
      if (!account) {
        throw new Error(`No usage account named "${nameOrOptions}" is added.`);
      }
      return read(account, {
        clock,
        history: named.history ?? true,
        signal: named.signal,
        since: sinceDate(named.since, clock),
      });
    }
    const { history = true, provider, signal, since } = nameOrOptions ?? {};
    signal?.throwIfAborted();
    const start = sinceDate(since, clock);
    const selected = [...accounts.values()].filter(
      (account) => provider === undefined || provider === account.provider?.id
    );
    return mapWithConcurrency(selected, concurrency, (account) =>
      read(account, { clock, history, signal, since: start })
    );
  };

  return {
    add,
    budget: async (name, callOptions) => {
      callOptions?.signal?.throwIfAborted();
      const account = accounts.get(name);
      if (!account) {
        return;
      }
      try {
        const result = await readBudget(account, clock, callOptions);
        callOptions?.signal?.throwIfAborted();
        return result;
      } catch {
        callOptions?.signal?.throwIfAborted();
      }
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
    queryAccount: (input, queryOptions = {}) => {
      queryOptions.signal?.throwIfAborted();
      return read(toRegistered(input), {
        clock,
        history: queryOptions.history ?? true,
        signal: queryOptions.signal,
        since: sinceDate(queryOptions.since, clock),
      });
    },
    remove: (name) => {
      const existing = accounts.get(name);
      if (!existing) {
        return false;
      }
      accounts.delete(name);
      const providerId = existing.provider?.id;
      if (providerId && stubProviders.has(providerId)) {
        const stillReferenced = [...accounts.values()].some(
          (account) => account.provider?.id === providerId
        );
        if (!stillReferenced) {
          providers.delete(providerId);
          stubProviders.delete(providerId);
        }
      }
      return true;
    },
    share: async (name, span?: Span, callOptions?: AccountCallOptions) => {
      callOptions?.signal?.throwIfAborted();
      const account = accounts.get(name);
      if (!account) {
        return;
      }
      let reading: Reading | undefined;
      try {
        reading = await account.limits(callOptions);
      } catch {
        callOptions?.signal?.throwIfAborted();
        return;
      }
      callOptions?.signal?.throwIfAborted();
      const limit = accountWide(reading.limits, span ?? "weekly");
      return limit && resolve(limit, clock()).headroom.share;
    },
    use: (provider) => {
      if (providers.has(provider.id) && !stubProviders.has(provider.id)) {
        throw new Error(`A usage provider "${provider.id}" is registered.`);
      }
      const replacingStub = stubProviders.delete(provider.id);
      providers.set(provider.id, provider);
      if (replacingStub) {
        rebindProvider(provider);
      }
    },
  };
};
