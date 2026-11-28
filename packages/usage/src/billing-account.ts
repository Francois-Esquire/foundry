import { spendCap } from "./limit";
import type { Reading } from "./snapshot";
import type { AccountCallOptions } from "./usage";

export type AdminKeySource =
  | string
  | ((options?: AccountCallOptions) => string | Promise<string>);

interface BillingSettings {
  readonly adminKey: AdminKeySource;
  readonly cap: number;
}

interface SpendReading {
  readonly reportedThrough?: Date;
  readonly resetsAt: Date;
  readonly spent: number;
  readonly startsAt: Date;
}

interface ManagedBilling {
  readonly cap: number;
  readSpend(options?: {
    readonly signal?: AbortSignal;
  }): SpendReading | undefined | Promise<SpendReading | undefined>;
}

export type BillingAccountOptions = { readonly name: string } & (
  | { readonly billing: ManagedBilling; readonly provider?: undefined }
  | {
      readonly billing: BillingSettings & { readonly projectId?: string };
      readonly provider: "openai";
    }
  | {
      readonly billing: BillingSettings & { readonly workspaceId?: string };
      readonly provider: "anthropic";
    }
);

export interface BillingReadRuntime {
  readonly billingTimeoutMs?: number;
  readonly clock?: () => Date;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxBillingPages?: number;
  readonly signal?: AbortSignal;
}

interface CostPage<T> {
  readonly data: readonly T[];
  readonly data_refreshed_at?: string | null;
  readonly has_more: boolean;
  readonly next_page: string | null;
}

interface Amount {
  readonly currency: string;
  readonly value: number;
}

const READ_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BILLING_PAGES = 50;
const ANTHROPIC_AMOUNT = /^-?\d+(?:\.\d+)?$/;

const billingSignal = (runtime: BillingReadRuntime): AbortSignal => {
  runtime.signal?.throwIfAborted();
  const timeoutMs = runtime.billingTimeoutMs ?? READ_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return runtime.signal
    ? AbortSignal.any([runtime.signal, timeoutSignal])
    : timeoutSignal;
};

const raceAbort = async <T>(
  work: () => T | Promise<T>,
  signal: AbortSignal
): Promise<T> => {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(signal.reason ?? new Error("The operation was aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const task = Promise.resolve().then(work);
  task.catch(() => undefined);
  try {
    return await Promise.race([task, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
};

const resolveAdminKey = async (
  source: AdminKeySource,
  signal: AbortSignal
): Promise<string> => {
  signal.throwIfAborted();
  const raw =
    typeof source === "function"
      ? await raceAbort(() => source({ signal }), signal)
      : source;
  signal.throwIfAborted();
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) {
    throw new Error("The billing admin key resolved to an empty value.");
  }
  return key;
};

const readCostPage = async <T>(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<CostPage<T>> => {
  const response = await fetchImpl(url.href, {
    headers,
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`The billing report returned HTTP ${response.status}.`);
  }
  const page = (await response.json()) as CostPage<T>;
  if (!(Array.isArray(page.data) && typeof page.has_more === "boolean")) {
    throw new Error("The billing report did not contain cost data.");
  }
  return page;
};

const nextCursorOf = (
  page: CostPage<unknown>,
  cursors: Set<string>
): string => {
  const cursor = page.next_page;
  if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) {
    throw new Error("The billing report did not include the next page.");
  }
  cursors.add(cursor);
  return cursor;
};

const readCosts = async <T>(
  url: URL,
  headers: Record<string, string>,
  amountOf: (row: T) => number,
  runtime: BillingReadRuntime,
  signal: AbortSignal
): Promise<{ total: number; reportedThrough?: Date }> => {
  const maxPages = runtime.maxBillingPages ?? DEFAULT_MAX_BILLING_PAGES;
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  const cursors = new Set<string>();
  let total = 0;
  let reportedThrough: Date | undefined;
  let pages = 0;
  let hasMore: boolean;
  do {
    pages += 1;
    if (pages > maxPages) {
      throw new Error(
        `The billing report exceeded the maximum page limit of ${maxPages}.`
      );
    }
    const page = await readCostPage<T>(fetchImpl, url, headers, signal);
    if (typeof page.data_refreshed_at === "string") {
      reportedThrough = new Date(page.data_refreshed_at);
    }
    for (const row of page.data) {
      total += amountOf(row);
    }
    if (!Number.isFinite(total)) {
      throw new Error("The billing report did not contain valid USD amounts.");
    }
    hasMore = page.has_more;
    if (hasMore) {
      url.searchParams.set("page", nextCursorOf(page, cursors));
    }
  } while (hasMore);
  return { reportedThrough, total };
};

const openAICost = async (
  { adminKey, projectId }: BillingSettings & { readonly projectId?: string },
  start: Date,
  at: Date,
  runtime: BillingReadRuntime
) => {
  const signal = billingSignal(runtime);
  const resolvedKey = await resolveAdminKey(adminKey, signal);
  const url = new URL("https://api.openai.com/v1/organization/costs");
  url.searchParams.set("start_time", String(start.getTime() / 1000));
  url.searchParams.set("end_time", String(Math.floor(at.getTime() / 1000)));
  url.searchParams.set("limit", "31");
  if (projectId !== undefined) {
    url.searchParams.set("project_ids[]", projectId);
  }
  return readCosts<{ results: readonly { amount: Amount }[] }>(
    url,
    { Authorization: `Bearer ${resolvedKey}` },
    ({ results }) =>
      results.reduce(
        (sum, { amount }) =>
          amount.currency === "usd" && typeof amount.value === "number"
            ? sum + amount.value
            : Number.NaN,
        0
      ),
    runtime,
    signal
  );
};

const anthropicCost = async (
  {
    adminKey,
    workspaceId,
  }: BillingSettings & { readonly workspaceId?: string },
  start: Date,
  at: Date,
  runtime: BillingReadRuntime
) => {
  const signal = billingSignal(runtime);
  const resolvedKey = await resolveAdminKey(adminKey, signal);
  const url = new URL(
    "https://api.anthropic.com/v1/organizations/analytics/cost"
  );
  url.searchParams.set("starting_at", start.toISOString());
  url.searchParams.set("ending_at", at.toISOString());
  if (workspaceId !== undefined) {
    url.searchParams.set("workspace_ids[]", workspaceId);
  }
  return readCosts<{ cost: { amount: string; currency: string } }>(
    url,
    {
      "anthropic-beta": "analytics-usage-cost-2026-08-24",
      "anthropic-version": "2023-06-01",
      "x-api-key": resolvedKey,
    },
    ({ cost }) =>
      cost.currency === "USD" &&
      typeof cost.amount === "string" &&
      ANTHROPIC_AMOUNT.test(cost.amount)
        ? Number(cost.amount) / 100
        : Number.NaN,
    runtime,
    signal
  );
};

const managedLimits = async (
  billing: ManagedBilling,
  runtime: BillingReadRuntime
): Promise<Reading> => {
  const signal = billingSignal(runtime);
  const spend = await raceAbort(() => billing.readSpend({ signal }), signal);
  signal.throwIfAborted();
  const at = runtime.clock ? runtime.clock() : new Date();
  if (
    !(
      spend &&
      Number.isFinite(spend.spent) &&
      spend.startsAt <= at &&
      at < spend.resetsAt
    ) ||
    (spend.reportedThrough && !(spend.reportedThrough >= spend.startsAt))
  ) {
    return { limits: [] };
  }
  return {
    limits: [
      spendCap({
        cap: billing.cap,
        reportedThrough: spend.reportedThrough,
        resetsAt: spend.resetsAt,
        startsAt: spend.startsAt,
        used: spend.spent,
      }),
    ],
  };
};

export const billingLimits = async (
  options: BillingAccountOptions,
  runtime: BillingReadRuntime = {}
): Promise<Reading> => {
  if (options.provider === undefined) {
    return managedLimits(options.billing, runtime);
  }
  const at = runtime.clock ? runtime.clock() : new Date();
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const startsAt = new Date(Date.UTC(year, month, 1));
  const resetsAt = new Date(Date.UTC(year, month + 1, 1));
  const { provider, billing } = options;
  const cost =
    provider === "openai"
      ? await openAICost(billing, startsAt, at, runtime)
      : await anthropicCost(billing, startsAt, at, runtime);
  const { reportedThrough, total } = cost;
  if (
    provider === "anthropic" &&
    !(reportedThrough && reportedThrough > startsAt)
  ) {
    return {
      limits: [],
      unsupported: "Billing data for this month is unavailable.",
    };
  }
  return {
    limits: [
      spendCap({
        cap: billing.cap,
        reportedThrough,
        resetsAt,
        startsAt,
        used: total,
      }),
    ],
  };
};
