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

// biome-ignore lint/suspicious/noEmptyInterface: providers add members by declaration merging.
export interface ProviderDetails {}

export interface Identity {
  readonly email?: string;
  readonly id: string;
  readonly plan?: string;
}

export interface Reading {
  readonly details?: ProviderDetails;
  readonly identity?: Identity;
  readonly limits: readonly ReportedLimit[];
  readonly unsupported?: string;
}

export interface Snapshot {
  readonly at: Date;
  readonly balance?: Balance;
  readonly consumption?: Consumption;
  readonly consumptionFailed?: string;
  readonly credits?: CreditBalance;
  readonly details?: ProviderDetails;
  readonly failed?: string;
  readonly hourly?: Window;
  readonly identity?: Identity;
  readonly limits: readonly Limit[];
  readonly monthly?: Window;
  readonly name: string;
  readonly provider?: string;
  readonly spendCap?: SpendCap;
  readonly unsupported?: string;
  readonly weekly?: Window;
}

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

export const snapshotOf = (
  account: { readonly name: string; readonly provider?: string },
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
