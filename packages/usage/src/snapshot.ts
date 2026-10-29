import type { Consumption } from "./consumption";
import {
  type Balance,
  type CreditBalance,
  compact,
  type Limit,
  type ReportedLimit,
  resolve,
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

/** One named account's usage at the moment it was queried. */
export interface Snapshot {
  /** When the limits were read: stamped just before the provider was asked. */
  readonly at: Date;
  readonly balance?: Balance;
  readonly consumption?: Consumption;
  /** This query could not read the consumption; the limits may still be read. */
  readonly consumptionFailed?: string;
  readonly credits?: CreditBalance;
  readonly details?: ProviderDetails;
  /** This query could not read the limits; the consumption may still be read. */
  readonly failed?: string;
  /** The account-wide window of each span. */
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
  /** Every window, custom and per-model ones included. */
  readonly windows: readonly Window[];
}

const NON_SLUG = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/** A model's key in `models`: "Opus 4.5" is `opus-4-5`. */
const slug = (model: string): string =>
  model.toLowerCase().replace(NON_SLUG, "-").replace(EDGE_DASHES, "");

/** Each account-wide window with the per-model windows of its span, first per slug. */
const withModels = (windows: readonly Window[]): Window[] =>
  windows.map((window) => {
    if (window.model !== undefined) {
      return window;
    }
    const models: Record<string, Window> = {};
    for (const scoped of windows) {
      if (scoped.model !== undefined && scoped.span === window.span) {
        models[slug(scoped.model)] ??= scoped;
      }
    }
    return Object.keys(models).length > 0 ? { ...window, models } : window;
  });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const firstOf = <K extends Limit["kind"]>(
  limits: readonly Limit[],
  kind: K
): Extract<Limit, { kind: K }> | undefined =>
  limits.find(
    (limit): limit is Extract<Limit, { kind: K }> => limit.kind === kind
  );

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
  const windows = withModels(
    resolved.filter((limit): limit is Window => limit.kind === "window")
  );
  const accountWide = (span: Window["span"]) =>
    windows.find(
      (window) => window.span === span && window.model === undefined
    );
  return compact({
    at,
    balance: firstOf(resolved, "balance"),
    consumption: history.status === "fulfilled" ? history.value : undefined,
    consumptionFailed:
      history.status === "rejected" ? messageOf(history.reason) : undefined,
    credits: firstOf(resolved, "credit-balance"),
    details: reading?.details,
    failed: limits.status === "rejected" ? messageOf(limits.reason) : undefined,
    hourly: accountWide("hourly"),
    identity: reading?.identity,
    monthly: accountWide("monthly"),
    name: account.name,
    provider: account.provider,
    spendCap: firstOf(resolved, "spend-cap"),
    unsupported: reading?.unsupported,
    weekly: accountWide("weekly"),
    windows,
  });
};
