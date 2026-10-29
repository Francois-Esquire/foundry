/** A length of time, in milliseconds. */
export type Duration = number;

/** An amount of money, in US dollars. */
export interface Money {
  readonly amount: number;
  readonly unit: "usd";
}

/** An amount in a provider's own credits, whose money value is unknown. */
export interface Credits {
  readonly amount: number;
  readonly unit: "credits";
}

/** What is left of a limit; `share` only when the limit has a total. */
export interface Headroom {
  readonly remaining: number;
  readonly share?: number;
  readonly unit: "percent" | "usd" | "credits";
}

/** What follows from a limit at the moment its snapshot was read. */
interface Resolution<H extends Headroom = Headroom> {
  readonly exhausted: boolean;
  readonly headroom: H;
  /** From the snapshot's `at`; absent when the limit never resets. */
  readonly resetsIn?: Duration;
}

export type Span = "hourly" | "weekly" | "monthly" | "custom";

/** An allowance limit over a span of time; its total is 100 percent. */
export interface Window extends Resolution<Required<Headroom>> {
  readonly duration: Duration;
  readonly kind: "window";
  /** Set on a window that applies to one model only, as the provider names it. */
  readonly model?: string;
  readonly resetsAt?: Date;
  readonly span: Span;
  readonly usedPercent: number;
}

/** A metered limit: the most money one billing period may be billed. */
export interface SpendCap extends Resolution<Required<Headroom>> {
  readonly cap: Money;
  readonly kind: "spend-cap";
  readonly resetsAt?: Date;
  readonly used: Money;
}

/** A prepaid limit: the money left to draw down. */
export interface Balance extends Resolution {
  readonly kind: "balance";
  readonly remaining: Money;
}

/** A credits limit: the credits left, in the provider's unit. */
export interface CreditBalance extends Resolution {
  readonly expiresAt?: Date;
  readonly kind: "credit-balance";
  readonly remaining: number;
}

/** One measure of an account's capacity, one kind per billing model. */
export type Limit = Window | SpendCap | Balance | CreditBalance;

/** A limit of one kind as a provider reports it, before the core resolves it. */
export type Reported<L> = L extends Limit ? Omit<L, keyof Resolution> : never;

/** A limit as a provider reports it, before the core resolves it. */
export type ReportedLimit = Reported<Limit>;

const HOUR: Duration = 3_600_000;
const WEEK: Duration = 168 * HOUR;
const MONTH: Duration = 720 * HOUR;
const WHOLE = 100;

/** `fields` without its undefined members, so a value stays plain data. */
export const compact = <T extends object>(fields: T): T =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as T;

interface WindowFields {
  readonly model?: string;
  readonly resetsAt?: Date;
  /** Clamped to 0 to 100. */
  readonly usedPercent: number;
}

const windowOf = (
  span: Span,
  duration: Duration,
  { model, resetsAt, usedPercent }: WindowFields
): Reported<Window> =>
  compact({
    duration,
    kind: "window",
    model,
    resetsAt,
    span,
    usedPercent: Math.min(WHOLE, Math.max(0, usedPercent)),
  });

/** Windows by span. A monthly window lasts 30 days. */
export const window = {
  custom: ({ duration, ...fields }: WindowFields & { duration: Duration }) =>
    windowOf("custom", duration, fields),
  hourly: ({ hours, ...fields }: WindowFields & { hours: number }) =>
    windowOf("hourly", hours * HOUR, fields),
  monthly: (fields: WindowFields) => windowOf("monthly", MONTH, fields),
  weekly: (fields: WindowFields) => windowOf("weekly", WEEK, fields),
};

const usd = (amount: number): Money => ({ amount, unit: "usd" });

/** Extra usage or an API spend limit: `used` and `cap` in dollars. */
export const spendCap = (fields: {
  readonly cap: number;
  readonly resetsAt?: Date;
  readonly used: number;
}): Reported<SpendCap> =>
  compact({
    cap: usd(fields.cap),
    kind: "spend-cap",
    resetsAt: fields.resetsAt,
    used: usd(fields.used),
  });

/** Prepaid money left, in dollars. */
export const balance = (fields: {
  readonly remaining: number;
}): Reported<Balance> => ({
  kind: "balance",
  remaining: usd(fields.remaining),
});

/** Credits left, in the provider's unit. */
export const credits = (fields: {
  readonly expiresAt?: Date;
  readonly remaining: number;
}): Reported<CreditBalance> =>
  compact({
    expiresAt: fields.expiresAt,
    kind: "credit-balance",
    remaining: fields.remaining,
  });

const headroomOf = (limit: ReportedLimit): Headroom => {
  switch (limit.kind) {
    case "window": {
      const remaining = Math.max(0, WHOLE - limit.usedPercent);
      return { remaining, share: remaining / WHOLE, unit: "percent" };
    }
    case "spend-cap": {
      const remaining = Math.max(0, limit.cap.amount - limit.used.amount);
      const share = limit.cap.amount > 0 ? remaining / limit.cap.amount : 0;
      return { remaining, share, unit: "usd" };
    }
    case "balance":
      return { remaining: Math.max(0, limit.remaining.amount), unit: "usd" };
    case "credit-balance":
      return { remaining: Math.max(0, limit.remaining), unit: "credits" };
    default:
      return limit satisfies never;
  }
};

/**
 * A reported limit with its headroom, time to reset from `at`, and whether
 * it is exhausted. Balances and credit balances are topped up, never reset;
 * credit expiry is not a reset.
 */
export const resolve = (limit: ReportedLimit, at: Date): Limit => {
  const headroom = headroomOf(limit);
  const resetsAt = "resetsAt" in limit ? limit.resetsAt : undefined;
  // The kind decides the headroom's shape, which the switch above keeps.
  return compact({
    ...limit,
    exhausted: headroom.remaining <= 0,
    headroom,
    resetsIn: resetsAt && Math.max(0, resetsAt.getTime() - at.getTime()),
  }) as Limit;
};
