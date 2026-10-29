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
  /** The account-wide window of each span, from `limits`. */
  readonly hourly?: Window;
  /** Who the provider says this account is; absent when the limits read failed. */
  readonly identity?: Identity;
  /** Every limit the provider reported, resolved; empty when none was read. */
  readonly limits: readonly Limit[];
  readonly monthly?: Window;
  readonly name: string;
  readonly provider: string;
  readonly spendCap?: SpendCap;
  /** This credential never has limits. */
  readonly unsupported?: string;
  readonly weekly?: Window;
}

/** The account-wide window of `span`: the one with no `model`. */
export const accountWide = <L extends ReportedLimit>(
  limits: readonly L[],
  span: Span
): Extract<L, { kind: "window" }> | undefined =>
  limits.find(
    (limit): limit is Extract<L, { kind: "window" }> =>
      limit.kind === "window" &&
      limit.span === span &&
      limit.model === undefined
  );

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
  return compact({
    at,
    balance: firstOf(resolved, "balance"),
    consumption: history.status === "fulfilled" ? history.value : undefined,
    consumptionFailed:
      history.status === "rejected" ? messageOf(history.reason) : undefined,
    credits: firstOf(resolved, "credit-balance"),
    details: reading?.details,
    failed: limits.status === "rejected" ? messageOf(limits.reason) : undefined,
    hourly: accountWide(resolved, "hourly"),
    identity: reading?.identity,
    limits: resolved,
    monthly: accountWide(resolved, "monthly"),
    name: account.name,
    provider: account.provider,
    spendCap: firstOf(resolved, "spend-cap"),
    unsupported: reading?.unsupported,
    weekly: accountWide(resolved, "weekly"),
  });
};
