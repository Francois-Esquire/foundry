interface ActiveTurn {
  controller: AbortController;
  message?: Promise<unknown>;
}

export interface GatedTurn {
  isActive(): boolean;
  /** Also aborts on interrupt and close. */
  readonly signal: AbortSignal;
}

/** Admits one turn at a time for a session labelled e.g. "Harness" or "Coding". */
export function createTurnGate(label: string) {
  let active: ActiveTurn | undefined;
  let closed = false;
  return {
    get active() {
      return active !== undefined;
    },
    /** Rejects later turns and returns the aborted turn's terminal message. */
    close(): Promise<unknown> {
      closed = true;
      const terminal = active?.message ?? Promise.resolve();
      active?.controller.abort(new Error(`${label} session closed.`));
      return terminal;
    },
    interrupt() {
      active?.controller.abort(new Error(`${label} turn interrupted.`));
    },
    /** Holds the gate until the body's message settles, or releases it if the body throws. */
    run<Result extends { message: Promise<unknown> }>(
      signal: AbortSignal | undefined,
      body: (turn: GatedTurn) => Result
    ): Result {
      if (closed) {
        throw new Error(`${label} session is closed.`);
      }
      if (active) {
        throw new Error(
          `A ${label.toLowerCase()} session can run only one turn at a time.`
        );
      }
      const turn: ActiveTurn = { controller: new AbortController() };
      active = turn;
      const release = () => {
        if (active === turn) {
          active = undefined;
        }
      };
      let result: Result;
      try {
        result = body({
          isActive: () => active === turn,
          signal: signal
            ? AbortSignal.any([turn.controller.signal, signal])
            : turn.controller.signal,
        });
      } catch (error) {
        release();
        throw error;
      }
      turn.message = result.message;
      result.message.then(release, release);
      return result;
    },
  };
}
