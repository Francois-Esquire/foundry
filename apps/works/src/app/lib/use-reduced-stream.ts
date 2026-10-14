import { useCallback, useEffect, useRef, useState } from "react";

/** How long to wait before opening the stream again after it dropped. */
const RECONNECT_MS = [1000, 2000, 5000, 10_000] as const;

export type StreamConnection =
  /** Waiting for the first event. */
  | "connecting"
  /** Following live changes. */
  | "live"
  /** Lost the stream; the last state stays until the stream opens again. */
  | "reconnecting"
  /** Main does not offer this stream; retrying is left to the person. */
  | "failed";

export interface ReducedStream<Event, State> {
  readonly initial: State;
  /**
   * Opens the stream. Its identity names the stream: a new `open` starts
   * over from `initial`; the same one is reopened after a drop.
   */
  readonly open: (signal: AbortSignal) => Promise<AsyncIterable<Event>>;
  /** Folds each event in; the first event of every opening is a snapshot. */
  readonly reduce: (state: State, event: Event) => State;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The connection to Works was lost.";
}

function unavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SERVICE_UNAVAILABLE"
  );
}

/**
 * Follows a snapshot-then-changes stream from main, folding it into state.
 * A stream that fails or ends opens again with backoff, and its fresh
 * snapshot replaces what was held, so nothing is duplicated and nothing
 * missed while away stays hidden. A stream main does not offer fails
 * without retrying until `retry`.
 */
export function useReducedStream<Event, State>({
  initial,
  open,
  reduce,
}: ReducedStream<Event, State>) {
  const [held, setHeld] = useState({ open, state: initial });
  const [connection, setConnection] = useState<StreamConnection>("connecting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const folding = useRef({ initial, reduce });
  folding.current = { initial, reduce };

  useEffect(() => {
    const controller = new AbortController();
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = async () => {
      try {
        const events = await open(controller.signal);
        for await (const event of events) {
          failures = 0;
          setHeld((current) => ({
            open,
            state: folding.current.reduce(
              current.open === open ? current.state : folding.current.initial,
              event
            ),
          }));
          setConnection("live");
          setError("");
        }
        throw new Error("The connection to Works ended.");
      } catch (caught) {
        if (controller.signal.aborted) {
          return;
        }
        setError(errorMessage(caught));
        if (unavailable(caught)) {
          setConnection("failed");
          return;
        }
        setConnection("reconnecting");
        const delay =
          RECONNECT_MS[Math.min(failures, RECONNECT_MS.length - 1)] ?? 10_000;
        failures += 1;
        timer = setTimeout(() => {
          follow().catch(() => undefined);
        }, delay);
      }
    };
    setConnection("connecting");
    follow().catch(() => undefined);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // `attempt` is a dependency so that `retry` opens the stream again.
  }, [open, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    connection,
    error,
    retry,
    state: held.open === open ? held.state : initial,
  };
}
