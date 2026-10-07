import type { HarnessSession } from "@foundry/agents/harness";

/** The lifecycle methods a host may take over without touching the session itself. */
type SessionOverrides = Partial<
  Pick<HarnessSession, "close" | "interrupt" | "stopActivity">
>;

/**
 * A session that forwards to `session` except where `overrides` says
 * otherwise. The original is left as it was, so whoever holds it still sees
 * its own behavior; hand the wrapper to whoever should see the overrides.
 */
export function wrapSession(
  session: HarnessSession,
  overrides: SessionOverrides
): HarnessSession {
  const close = overrides.close ?? session.close?.bind(session);
  const stopActivity =
    overrides.stopActivity ?? session.stopActivity?.bind(session);
  return {
    get capabilities() {
      return session.capabilities;
    },
    ...(close ? { close } : {}),
    generate: (input, options) => session.generate(input, options),
    interrupt: overrides.interrupt ?? (() => session.interrupt()),
    get route() {
      return session.route;
    },
    get sessionId() {
      return session.sessionId;
    },
    steer: (input) => session.steer(input),
    ...(stopActivity ? { stopActivity } : {}),
    get store() {
      return session.store;
    },
    stream: (input, options) => session.stream(input, options),
  };
}
