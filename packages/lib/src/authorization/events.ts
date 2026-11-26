import type { AuthorizationAddress, AuthorizationSubject } from "./address";

export type AuthorizationEventKind =
  | "issued"
  | "approved"
  | "denied"
  | "revoked"
  | "expired"
  | "claimed"
  | "exercised";

export interface AuthorizationEvent<S extends AuthorizationSubject, C> {
  readonly address: AuthorizationAddress<S>;
  readonly at: number;
  readonly capability?: C;
  readonly certificateId?: string;
  readonly grantId?: string;
  readonly invocationId?: string;
  readonly kind: AuthorizationEventKind;
  readonly reason?: string;
}

export interface AuthorizationEventSink<S extends AuthorizationSubject, C> {
  emit: (event: AuthorizationEvent<S, C>) => void;
}
