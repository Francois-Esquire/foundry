/**
 * Policy: the rules consulted when exact authority does not settle a request.
 *
 * Policy here means *only* rules. It does not manage storage, it does not wait
 * for a human, and it does not mint Grants. That narrowing is the whole reason
 * this module exists — the previous `Policy` type meant rules, manager,
 * persistence writer, and human gate at once, so no caller could tell which of
 * the four it was depending on.
 */

import type { AuthorizationSubject } from "./address";

/**
 * The three-way setting. `"allow"` and `"deny"` settle without a human;
 * `"ask"` means the caller must reach an approval checkpoint before the effect
 * can run.
 */
export type AuthorizationMode = "allow" | "ask" | "deny";

/**
 * A host-configured denial of one exact Subject/Capability pair.
 *
 * Expressed as a rule rather than a negative Grant so that "this is forbidden"
 * and "this is permitted" never live in the same table, where a bug in one
 * could produce the other.
 */
export interface AuthorizationDenyRule<S extends AuthorizationSubject, C> {
  readonly capability: C;
  readonly reason: string;
  readonly subject: S;
}

/**
 * The declarative rule set.
 *
 * `failClosed` names kinds that must not inherit {@link global}. A kind belongs
 * there when its shape tells Policy nothing about what the effect actually
 * does, so a blanket `"allow"` written for understood kinds would be unsafe.
 * With no exact deny, no live Grant, and no explicit `byKind` entry, such a
 * kind denies rather than reaching the global tier.
 *
 * A deny-by-default posture is `global: "deny"` — adopting these tiers does not
 * relax it.
 */
export interface AuthorizationPolicy<
  S extends AuthorizationSubject,
  C,
  K extends string = string,
> {
  readonly byKind?: Partial<Record<K, AuthorizationMode>>;
  readonly exactDenies?: readonly AuthorizationDenyRule<S, C>[];
  readonly failClosed?: readonly K[];
  readonly global: AuthorizationMode;
}

/**
 * A live source of Policy, read per decision so a host can change a mode at
 * runtime without rebuilding the Authorizer.
 *
 * Reads are SYNCHRONOUS on purpose. The Authorizer snapshots the whole Policy
 * before its first `await`, so one decision cannot answer its deny tier from
 * one configuration and its global tier from another when a settings write
 * lands mid-lookup. An async source could not offer that guarantee.
 */
export interface AuthorizationPolicySource<
  S extends AuthorizationSubject,
  C,
  K extends string = string,
> {
  current: () => AuthorizationPolicy<S, C, K>;
}

/** Narrow a policy option that may be either a fixed value or a live source. */
export function resolvePolicy<
  S extends AuthorizationSubject,
  C,
  K extends string,
>(
  policy: AuthorizationPolicy<S, C, K> | AuthorizationPolicySource<S, C, K>
): AuthorizationPolicy<S, C, K> {
  return "current" in policy ? policy.current() : policy;
}
