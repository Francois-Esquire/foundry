/**
 * Append-only authorization history.
 *
 * Current authority comes from the grant repository; this stream records
 * history. A host that wants durable history supplies storage for the sink.
 */

import type { AuthorizationAddress, AuthorizationSubject } from "./address";

/**
 * What happened to authority.
 *
 * `claimed` is one invocation taking authority at the effect boundary;
 * `exercised` is the effect actually running. They are separate because a claim
 * that is never exercised is exactly the signal that something failed between
 * authorization and execution.
 */
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

/**
 * Where events go.
 *
 * Emission is synchronous. A thrown error propagates and can interrupt a
 * decision even after authority has changed. A sink that needs durability
 * buffers internally.
 */
export interface AuthorizationEventSink<S extends AuthorizationSubject, C> {
  emit: (event: AuthorizationEvent<S, C>) => void;
}
