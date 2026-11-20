import type { HarnessSession, TurnOptions } from "@foundry/agents/harness";
import type { SessionInput } from "@foundry/agents/session";
import type { Output } from "ai";
import type { RecordObservation } from "~/lib/observations";
import { observeCliTurn, toolObserver } from "~/lib/observations";

type SessionOverrides = Partial<
  Pick<HarnessSession, "close" | "interrupt" | "stopActivity" | "stream">
>;

export function wrapSession(
  session: HarnessSession,
  overrides: SessionOverrides
): HarnessSession {
  const close = overrides.close ?? session.close?.bind(session);
  const stopActivity =
    overrides.stopActivity ?? session.stopActivity?.bind(session);
  const { stream } = overrides;
  return {
    get capabilities() {
      return session.capabilities;
    },
    ...(close ? { close } : {}),
    generate: stream
      ? (input, options) => stream(input, options).message
      : (input, options) => session.generate(input, options),
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
    stream: stream ?? ((input, options) => session.stream(input, options)),
  };
}

export function observedSession(
  session: HarnessSession,
  record: RecordObservation,
  observe: { readonly tools: boolean; readonly turns: boolean }
): HarnessSession {
  const stream = <OUTPUT extends Output.Output = never>(
    input: SessionInput,
    options: TurnOptions<OUTPUT> = {}
  ) => {
    const tools = observe.tools
      ? toolObserver(record, session.sessionId)
      : undefined;
    const turn = session.stream<OUTPUT>(
      input,
      tools
        ? {
            ...options,
            onHarnessTool: (event) => {
              tools.event({ event, type: "harness-tool" });
              options.onHarnessTool?.(event);
            },
            onToolCall: (event) => {
              tools.event({ ...event, type: "tool-call" });
              options.onToolCall?.(event);
            },
            onToolResult: (event) => {
              tools.event({ ...event, type: "tool-result" });
              options.onToolResult?.(event);
            },
          }
        : options
    );
    if (observe.turns) {
      observeCliTurn(
        record,
        {
          model: session.route.id,
          ...(session.route.provider === undefined
            ? {}
            : { provider: session.route.provider }),
          sessionId: session.sessionId,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        turn
      );
    }
    if (tools) {
      turn.message.then(tools.end, tools.end);
    }
    return turn;
  };
  return wrapSession(session, { stream });
}
