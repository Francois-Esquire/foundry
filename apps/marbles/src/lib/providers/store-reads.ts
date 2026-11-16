/**
 * How the provider store's reads stand, as the configuration's watcher
 * sees them: a small state machine per read, and one rule for what the
 * whole store reports, so what is reported and what is tried again can
 * be checked by reading `nextRead`, `moveReads` and `retriedOn`.
 *
 * A read is `fine`; `unreachable`, when the store could not be reached
 * (a lock held too long, say), with the last reason; or `invalid` at a
 * revision, when what the store holds cannot be used as it is (a
 * configuration that does not parse, an identity key that is not one).
 */

/** A read of the store, in the order the store's reason is taken from. */
export type StoreRead = "configuration" | "identity key" | "revision";

const READS: readonly StoreRead[] = [
  "configuration",
  "identity key",
  "revision",
];

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

/** Every read's state. */
export type StoreReads = Readonly<Record<StoreRead, ReadState>>;

export const FINE: ReadState = { kind: "fine" };

export const ALL_FINE: StoreReads = {
  configuration: FINE,
  "identity key": FINE,
  revision: FINE,
};

/** Reported once the store can be reached again. */
export const RECOVERED = "the provider configuration can be read again";

/**
 * How often, in polls, a stored identity key that is not one is read
 * again though the revision has not moved: the key is kept apart from
 * the configuration, so removing it, as its error says to, moves no
 * revision.
 */
export const KEY_RECHECK_POLLS = 10;

/**
 * The state `event` leaves one read in:
 *
 * | event          | any state         |
 * | -------------- | ----------------- |
 * | succeeded      | fine              |
 * | unreachable(m) | unreachable(m)    |
 * | invalid(m, r)  | invalid(m, r)     |
 * | not needed     | fine              |
 */
export function nextRead(_state: ReadState, event: ReadEvent): ReadState {
  switch (event.kind) {
    case "succeeded":
    case "not needed":
      return FINE;
    case "unreachable":
      return { kind: "unreachable", message: event.message };
    case "invalid":
      return {
        kind: "invalid",
        message: event.message,
        revision: event.revision,
      };
    default:
      return event satisfies never;
  }
}

/** Why the store cannot be reached, from the first read that could not: undefined when every read can. */
export function unreachableOf(reads: StoreReads): string | undefined {
  for (const read of READS) {
    const state = reads[read];
    if (state.kind === "unreachable") {
      return state.message;
    }
  }
}

/**
 * Move `read` by `event`, and say what the store reports for it:
 *
 * - invalid content, when the read's content or revision changed;
 * - the store's reason it cannot be reached, when it changed, whichever
 *   read gives it (two reads failing for one reason report it once);
 * - `RECOVERED`, once no read is unreachable, and only when the move
 *   that cleared the last one was that read succeeding (a read no longer
 *   needed, or content found invalid, recovers nothing).
 */
export function moveReads(
  reads: StoreReads,
  read: StoreRead,
  event: ReadEvent
): { readonly reads: StoreReads; readonly reports: readonly string[] } {
  const before = reads[read];
  const after: StoreReads = { ...reads, [read]: nextRead(before, event) };
  const reports: string[] = [];
  if (
    event.kind === "invalid" &&
    !(
      before.kind === "invalid" &&
      before.message === event.message &&
      before.revision === event.revision
    )
  ) {
    reports.push(event.message);
  }
  const was = unreachableOf(reads);
  const now = unreachableOf(after);
  if (now !== undefined && now !== was) {
    reports.push(now);
  }
  if (was !== undefined && now === undefined && event.kind === "succeeded") {
    reports.push(RECOVERED);
  }
  return { reads: after, reports };
}

/**
 * Whether the watcher tries `read` again on poll number `poll`, whatever
 * the revision: an unreachable read on every poll; a stored identity key
 * that is not one every `KEY_RECHECK_POLLS` polls; nothing else, which is
 * read again only once the revision moves.
 */
export function retriedOn(
  read: StoreRead,
  state: ReadState,
  poll: number
): boolean {
  if (state.kind === "unreachable") {
    return true;
  }
  return (
    read === "identity key" &&
    state.kind === "invalid" &&
    poll % KEY_RECHECK_POLLS === 0
  );
}
