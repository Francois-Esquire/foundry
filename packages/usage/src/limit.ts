export type Duration = number;

export interface Money {
  readonly amount: number;
  readonly unit: "usd";
}

export interface Credits {
  readonly amount: number;
  readonly unit: "credits";
}

export interface Headroom {
  readonly remaining: number;
  readonly share?: number;
  readonly unit: "percent" | "usd" | "credits";
}

interface Resolution<H extends Headroom = Headroom> {
  readonly exhausted: boolean;
  readonly headroom: H;
  readonly resetsIn?: Duration;
}

export type Span = "hourly" | "weekly" | "monthly" | "custom";

export interface Window extends Resolution<Required<Headroom>> {
  readonly duration: Duration;
  readonly kind: "window";
  readonly model?: string;
  readonly resetsAt?: Date;
  readonly span: Span;
  readonly usedPercent: number;
}

export interface SpendCap extends Resolution<Required<Headroom>> {
  readonly cap: Money;
  readonly kind: "spend-cap";
  readonly resetsAt?: Date;
  readonly used: Money;
}

export interface Balance extends Resolution {
  readonly kind: "balance";
  readonly remaining: Money;
}

export interface CreditBalance extends Resolution {
  readonly expiresAt?: Date;
  readonly kind: "credit-balance";
  readonly remaining: number;
}

export type Limit = Window | SpendCap | Balance | CreditBalance;

export type Reported<L> = L extends Limit ? Omit<L, keyof Resolution> : never;

export type ReportedLimit = Reported<Limit>;

const HOUR: Duration = 3_600_000;
const WEEK: Duration = 168 * HOUR;
const MONTH: Duration = 720 * HOUR;
const WHOLE = 100;

export const compact = <T extends object>(fields: T): T =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as T;

interface WindowFields {
  readonly model?: string;
  readonly resetsAt?: Date;
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

export const window = {
  custom: ({ duration, ...fields }: WindowFields & { duration: Duration }) =>
    windowOf("custom", duration, fields),
  hourly: ({ hours, ...fields }: WindowFields & { hours: number }) =>
    windowOf("hourly", hours * HOUR, fields),
  monthly: (fields: WindowFields) => windowOf("monthly", MONTH, fields),
  weekly: (fields: WindowFields) => windowOf("weekly", WEEK, fields),
};

const usd = (amount: number): Money => ({ amount, unit: "usd" });

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

export const balance = (fields: {
  readonly remaining: number;
}): Reported<Balance> => ({
  kind: "balance",
  remaining: usd(fields.remaining),
});

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

export const resolve = (limit: ReportedLimit, at: Date): Limit => {
  const headroom = headroomOf(limit);
  const resetsAt = "resetsAt" in limit ? limit.resetsAt : undefined;
  return compact({
    ...limit,
    exhausted: headroom.remaining <= 0,
    headroom,
    resetsIn: resetsAt && Math.max(0, resetsAt.getTime() - at.getTime()),
  }) as Limit;
};
