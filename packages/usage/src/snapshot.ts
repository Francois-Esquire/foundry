import type { Consumption } from "./consumption";
import {
  type Balance,
  type CreditBalance,
  compact,
  type Limit,
  type ReportedLimit,
  resolve,
  type Span,
  type SpendCap,
  type Window,
} from "./limit";

/**
 * What only one provider reports, keyed by provider id. Each provider adds
 * its own optional member by declaration merging:
 *
 * ```ts
 * declare module "@foundry/usage" {
 *   interface ProviderDetails {
 *     readonly anthropic?: AnthropicDetails;
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: providers add members by declaration merging.
export interface ProviderDetails {}

/** The provider's own identity for an account, learned from a reading. */
export interface Identity {
  readonly email?: string;
  readonly id: string;
  readonly plan?: string;
}

/** What a provider reported about one account's limits when asked. */
export interface Reading {
  readonly details?: ProviderDetails;
  readonly identity?: Identity;
  readonly limits: readonly ReportedLimit[];
  /** Set when this credential never has limits. */
  readonly unsupported?: string;
}

/**
 * One named account's usage at the moment it was queried. Of two limits
 * reached the same way, the first reported is kept.
 */
export interface Snapshot {
  /** When the limits were read: stamped just before the provider was asked. */
  readonly at: Date;
  readonly balance?: Balance;
  readonly consumption?: Consumption;
  readonly credits?: CreditBalance;
  /** Every window whose span is custom, per-model ones included, as reported. */
  readonly custom?: readonly Window[];
  readonly details?: ProviderDetails;
  /** What this query could not read; one failing never hides the other. */
  readonly errors?: {
    readonly consumption?: string;
    readonly limits?: string;
  };
  readonly hourly?: Window;
  /** Who the provider says this account is; absent when the limits read failed. */
  readonly identity?: Identity;
  readonly monthly?: Window;
  readonly name: string;
  readonly provider: string;
  readonly spendCap?: SpendCap;
  /** This credential never has limits. */
  readonly unsupported?: string;
  readonly weekly?: Window;
}

const NON_SLUG = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/** A model's key in `models`: "Opus 4.5" is `opus-4-5`. */
const slug = (model: string): string =>
  model.toLowerCase().replace(NON_SLUG, "-").replace(EDGE_DASHES, "");

const errorOf = (result: PromiseSettledResult<unknown>): string | undefined => {
  if (result.status === "rejected") {
    const { reason } = result;
    return reason instanceof Error ? reason.message : String(reason);
  }
};

const firstOf = <K extends Limit["kind"]>(
  limits: readonly Limit[],
  kind: K
): Extract<Limit, { kind: K }> | undefined =>
  limits.find(
    (limit): limit is Extract<Limit, { kind: K }> => limit.kind === kind
  );

/** The first account-wide window of `span`, if any, with its span's first per-model window per slug. */
const spanOf = (windows: readonly Window[], span: Span): Window | undefined => {
  const ofSpan = windows.filter((window) => window.span === span);
  const accountWide = ofSpan.find((window) => window.model === undefined);
  const models: Record<string, Window> = {};
  for (const window of ofSpan) {
    if (window.model !== undefined) {
      models[slug(window.model)] ??= window;
    }
  }
  return accountWide && Object.keys(models).length > 0
    ? { ...accountWide, models }
    : accountWide;
};

/**
 * One account's snapshot from what one query read: its limits resolved
 * against `at`, and its consumption. Either read failing leaves the other.
 */
export const snapshotOf = (
  account: { readonly name: string; readonly provider: string },
  at: Date,
  limits: PromiseSettledResult<Reading>,
  history: PromiseSettledResult<Consumption | undefined>
): Snapshot => {
  const reading = limits.status === "fulfilled" ? limits.value : undefined;
  const resolved = (reading?.limits ?? []).map((limit) => resolve(limit, at));
  const windows = resolved.filter(
    (limit): limit is Window => limit.kind === "window"
  );
  const custom = windows.filter((window) => window.span === "custom");
  const errors = compact({
    consumption: errorOf(history),
    limits: errorOf(limits),
  });
  return compact({
    at,
    balance: firstOf(resolved, "balance"),
    consumption: history.status === "fulfilled" ? history.value : undefined,
    credits: firstOf(resolved, "credit-balance"),
    custom: custom.length > 0 ? custom : undefined,
    details: reading?.details,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
    hourly: spanOf(windows, "hourly"),
    identity: reading?.identity,
    monthly: spanOf(windows, "monthly"),
    name: account.name,
    provider: account.provider,
    spendCap: firstOf(resolved, "spend-cap"),
    unsupported: reading?.unsupported,
    weekly: spanOf(windows, "weekly"),
  });
};
