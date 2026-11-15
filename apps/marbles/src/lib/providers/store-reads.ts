/**
 * How each read of the provider store stands, as the configuration's
 * watcher sees it: a small state machine per read, so what is reported
 * and what is tried again can be checked by reading `nextRead`.
 *
 * A read is `fine`; `unreachable`, when the store could not be reached
 * (a lock held too long, say), with the last reason; or `invalid` at a
 * revision, when what the store holds cannot be used as it is (a
 * configuration that does not parse, an identity key that is not one).
 * An unreachable read is tried again on every poll; an invalid one only
 * once the revision changes, since reading it again reads the same.
 */

/** A read of the store. */
export type StoreRead = "configuration" | "identity key" | "revision";

export type ReadState =
  | { readonly kind: "fine" }
  | { readonly kind: "unreachable"; readonly message: string }
  | {
      readonly kind: "invalid";
      readonly message: string;
      readonly revision: number | undefined;
    };

export type ReadEvent =
  /** The read succeeded. */
  | { readonly kind: "succeeded" }
  /** The read could not reach the store. */
  | { readonly kind: "unreachable"; readonly message: string }
  /** What the read found cannot be used, at this revision. */
  | {
      readonly kind: "invalid";
      readonly message: string;
      readonly revision: number | undefined;
    }
  /** Nothing needs this read now (no configuration asks for a key). */
  | { readonly kind: "not needed" };

export const FINE: ReadState = { kind: "fine" };

/** Reported once a read that could not reach the store succeeds. */
export const RECOVERED = "the provider configuration can be read again";

/**
 * The state `event` leaves a read in, and what to report, if anything:
 *
 * | from \ event   | succeeded         | unreachable(m)          | invalid(m, r)                  | not needed |
 * | -------------- | ----------------- | ----------------------- | ------------------------------ | ---------- |
 * | fine           | fine              | unreachable(m), m       | invalid(m, r), m               | fine       |
 * | unreachable(p) | fine, RECOVERED   | unreachable(m), m if ≠p | invalid(m, r), m               | fine       |
 * | invalid(p, q)  | fine              | unreachable(m), m       | invalid(m, r), m if (m,r)≠(p,q) | fine       |
 *
 * Recovery is reported only when the read that could not reach the store
 * itself succeeds: a read no longer needed recovers nothing.
 */
export function nextRead(
  state: ReadState,
  event: ReadEvent
): { readonly report?: string; readonly state: ReadState } {
  switch (event.kind) {
    case "succeeded":
      return state.kind === "unreachable"
        ? { report: RECOVERED, state: FINE }
        : { state: FINE };
    case "not needed":
      return { state: FINE };
    case "unreachable": {
      const next: ReadState = { kind: "unreachable", message: event.message };
      const same =
        state.kind === "unreachable" && state.message === event.message;
      return same ? { state: next } : { report: event.message, state: next };
    }
    case "invalid": {
      const next: ReadState = {
        kind: "invalid",
        message: event.message,
        revision: event.revision,
      };
      const same =
        state.kind === "invalid" &&
        state.message === event.message &&
        state.revision === event.revision;
      return same ? { state: next } : { report: event.message, state: next };
    }
    default:
      return event satisfies never;
  }
}

/** Whether the watcher tries this read again on its next poll, whatever the revision. */
export function retried(state: ReadState): boolean {
  return state.kind === "unreachable";
}
