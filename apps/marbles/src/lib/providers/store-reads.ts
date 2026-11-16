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
  | { readonly kind: "succeeded" }
  | { readonly kind: "unreachable"; readonly message: string }
  | {
      readonly kind: "invalid";
      readonly message: string;
      readonly revision: number | undefined;
    }
  | { readonly kind: "not needed" };

export type StoreReads = Readonly<Record<StoreRead, ReadState>>;

export const FINE: ReadState = { kind: "fine" };

export const ALL_FINE: StoreReads = {
  configuration: FINE,
  "identity key": FINE,
  revision: FINE,
};

export const RECOVERED = "the provider configuration can be read again";

export const KEY_RECHECK_POLLS = 10;

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

function unreachableOf(reads: StoreReads): string | undefined {
  for (const read of READS) {
    const state = reads[read];
    if (state.kind === "unreachable") {
      return state.message;
    }
  }
}

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
