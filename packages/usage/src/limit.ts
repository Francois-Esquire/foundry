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

/** An allowance limit over a span of time; its total is 100 percent. */
export interface Window {
  readonly id: string;
  readonly kind: "window";
  readonly resetsAt?: Date;
  readonly span: Duration;
  readonly usedPercent: number;
}

/** A metered limit: the most money one billing period may be billed. */
export interface SpendCap {
  readonly cap: Money;
  readonly kind: "spend-cap";
  readonly resetsAt?: Date;
  readonly used: Money;
}

/** A prepaid limit: the money left to draw down. */
export interface Balance {
  readonly kind: "balance";
  readonly remaining: Money;
}

/** A credits limit: the credits left, in the provider's unit. */
export interface CreditBalance {
  readonly expiresAt?: Date;
  readonly kind: "credit-balance";
  readonly remaining: number;
}

/** One measure of an account's capacity, one kind per billing model. */
export type Limit = Window | SpendCap | Balance | CreditBalance;

/** What is left of a limit; `share` only when the limit has a total. */
export interface Headroom {
  readonly remaining: number;
  readonly share?: number;
  readonly unit: "percent" | "usd" | "credits";
}

const WHOLE_WINDOW_PERCENT = 100;

/** What is left of a limit. Windows and spend caps always have a share. */
export function headroom(limit: Window | SpendCap): Required<Headroom>;
export function headroom(limit: Limit): Headroom;
export function headroom(limit: Limit): Headroom {
  switch (limit.kind) {
    case "window": {
      const remaining = Math.max(0, WHOLE_WINDOW_PERCENT - limit.usedPercent);
      return {
        remaining,
        share: remaining / WHOLE_WINDOW_PERCENT,
        unit: "percent",
      };
    }
    case "spend-cap": {
      const remaining = Math.max(0, limit.cap.amount - limit.used.amount);
      const share = limit.cap.amount > 0 ? remaining / limit.cap.amount : 0;
      return { remaining, share, unit: limit.cap.unit };
    }
    case "balance":
      return {
        remaining: Math.max(0, limit.remaining.amount),
        unit: limit.remaining.unit,
      };
    case "credit-balance":
      return { remaining: Math.max(0, limit.remaining), unit: "credits" };
    default:
      return limit satisfies never;
  }
}

/**
 * Time until the limit's capacity comes back, or `undefined` when it never
 * resets. Balances and credit balances are topped up, never reset; credit
 * expiry is not a reset.
 */
export const resetsIn = (
  limit: Limit,
  now: Date = new Date()
): Duration | undefined => {
  if (limit.kind !== "window" && limit.kind !== "spend-cap") {
    return;
  }
  if (!limit.resetsAt) {
    return;
  }
  return Math.max(0, limit.resetsAt.getTime() - now.getTime());
};

/** A limit with no headroom left. */
export const exhausted = (limit: Limit): boolean =>
  headroom(limit).remaining <= 0;
