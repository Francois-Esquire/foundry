import type { AuthorizationSubject } from "./address";

export type AuthorizationMode = "allow" | "ask" | "deny";

export interface AuthorizationDenyRule<S extends AuthorizationSubject, C> {
  readonly capability: C;
  readonly reason: string;
  readonly subject: S;
}

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

export interface AuthorizationPolicySource<
  S extends AuthorizationSubject,
  C,
  K extends string = string,
> {
  current: () => AuthorizationPolicy<S, C, K>;
}

export function resolvePolicy<
  S extends AuthorizationSubject,
  C,
  K extends string,
>(
  policy: AuthorizationPolicy<S, C, K> | AuthorizationPolicySource<S, C, K>
): AuthorizationPolicy<S, C, K> {
  return "current" in policy ? policy.current() : policy;
}
