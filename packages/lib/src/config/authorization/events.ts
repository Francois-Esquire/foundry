/**
 * Append-only authorization history.
 *
 * This is where the word "ledger" would be accurate, and it is deliberately
 *not* the interface the Authorizer uses to find current authority. Current
 * authority is a repository lookup (`grant.ts`); history is this stream. The
 * previous design pressure was to call the mutable CRUD store a ledger, which
 * would have meant either replaying history on every tool call or keeping a
 * "ledger" that quietly forgot things.
 *
 * Contract only. Nothing here persists anything — a host that wants durable
 * history implements the sink over its own storage.
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
 * Synchronous and returning nothing, so recording history can never add an
 * `await` to the decision path or fail a decision that already succeeded. A
 * sink that needs durability buffers internally.
 */
export interface AuthorizationEventSink<S extends AuthorizationSubject, C> {
  emit: (event: AuthorizationEvent<S, C>) => void;
}
