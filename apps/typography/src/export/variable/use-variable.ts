/** What the variable font section reads: its session, and a clock for a build under way. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useApplication } from "~/application/react";
import type { VariableSession, VariableSessionState } from "./variable-session";

export const useVariableSession = (): {
  readonly session: VariableSession;
  readonly state: VariableSessionState;
} => {
  const session = useApplication().places.variable;
  const state = useSyncExternalStore(
    session.subscribe,
    session.getState,
    session.getState
  );
  return { session, state };
};

const SECOND = 1000;

/** Whole seconds since the component appeared, so a long wait is seen to move. */
export const useElapsedSeconds = (): number => {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / SECOND)),
      SECOND
    );
    return () => clearInterval(timer);
  }, []);
  return seconds;
};
