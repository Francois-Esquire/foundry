import { spendCap } from "./limit";
import type { Reading } from "./snapshot";

interface BillingSettings {
  readonly adminKey: string;
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
  readSpend(): SpendReading | undefined | Promise<SpendReading | undefined>;
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
const ANTHROPIC_AMOUNT = /^-?\d+(?:\.\d+)?$/;

const readCosts = async <T>(
  url: URL,
  headers: Record<string, string>,
  amountOf: (row: T) => number
): Promise<{ total: number; reportedThrough?: Date }> => {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const cursors = new Set<string>();
  let total = 0;
  let reportedThrough: Date | undefined;
  let hasMore: boolean;
  do {
    const response = await fetch(url.href, {
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
      const cursor = page.next_page;
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) {
        throw new Error("The billing report did not include the next page.");
      }
      cursors.add(cursor);
      url.searchParams.set("page", cursor);
    }
  } while (hasMore);
  return { reportedThrough, total };
};

const openAICost = (
  { adminKey, projectId }: BillingSettings & { readonly projectId?: string },
  start: Date,
  at: Date
) => {
  const url = new URL("https://api.openai.com/v1/organization/costs");
  url.searchParams.set("start_time", String(start.getTime() / 1000));
  url.searchParams.set("end_time", String(Math.floor(at.getTime() / 1000)));
  url.searchParams.set("limit", "31");
  if (projectId !== undefined) {
    url.searchParams.set("project_ids[]", projectId);
  }
  return readCosts<{ results: readonly { amount: Amount }[] }>(
    url,
    { Authorization: `Bearer ${adminKey}` },
    ({ results }) =>
      results.reduce(
        (sum, { amount }) =>
          amount.currency === "usd" && typeof amount.value === "number"
            ? sum + amount.value
            : Number.NaN,
        0
      )
  );
};

const anthropicCost = (
  {
    adminKey,
    workspaceId,
  }: BillingSettings & { readonly workspaceId?: string },
  start: Date,
  at: Date
) => {
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
      "x-api-key": adminKey,
    },
    ({ cost }) =>
      cost.currency === "USD" &&
      typeof cost.amount === "string" &&
      ANTHROPIC_AMOUNT.test(cost.amount)
        ? Number(cost.amount) / 100
        : Number.NaN
  );
};

const managedLimits = async (billing: ManagedBilling): Promise<Reading> => {
  const spend = await billing.readSpend();
  const at = new Date();
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
  options: BillingAccountOptions
): Promise<Reading> => {
  if (options.provider === undefined) {
    return managedLimits(options.billing);
  }
  const at = new Date();
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const startsAt = new Date(Date.UTC(year, month, 1));
  const resetsAt = new Date(Date.UTC(year, month + 1, 1));
  const { provider, billing } = options;
  const cost =
    provider === "openai"
      ? await openAICost(billing, startsAt, at)
      : await anthropicCost(billing, startsAt, at);
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
