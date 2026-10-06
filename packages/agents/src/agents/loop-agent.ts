import type {
  AgentCallParameters,
  AgentStreamParameters,
  GenerateTextResult,
  StreamTextResult,
  Telemetry,
  TelemetryOptions,
  ToolLoopAgentSettings,
  ToolSet,
} from "ai";

import { smoothStream, ToolLoopAgent } from "ai";

import type { AgentModel, ObserveTurn, TurnObservation } from "./model";

import { routeOf } from "./model";

export type LoopAgentSettings = Omit<
  ToolLoopAgentSettings<never, ToolSet>,
  "model" | "onFinish"
> & {
  model: AgentModel;
  /** Opens one observation per `stream`/`generate` call; omit to run unobserved. */
  observe?: ObserveTurn;
  onFinish?: (result: unknown) => void;
};

/**
 * Settings one call may override. `ToolLoopAgent` spreads a call's parameters
 * over its own settings before preparing the call, so these reach the model
 * call even though `AgentCallParameters` does not declare them.
 */
type CallSettings = Pick<
  ToolLoopAgentSettings<never, ToolSet>,
  "model" | "providerOptions" | "telemetry"
>;

export type LoopAgentCallParameters = AgentCallParameters<never, ToolSet> &
  Pick<CallSettings, "providerOptions">;
export type LoopAgentStreamParameters = AgentStreamParameters<never, ToolSet> &
  Pick<CallSettings, "providerOptions">;

export interface TurnContext {
  sessionId: string;
}

/** The thrown value a telemetry `onError` event carries. */
function errorOf(event: unknown): unknown {
  return typeof event === "object" && event !== null && "error" in event
    ? event.error
    : event;
}

/**
 * The call settings that put one call under `observation`: its wrapped model,
 * and its telemetry with a settle hook appended. The wide event is settled
 * from telemetry rather than from `onFinish` or the drained stream because
 * telemetry is where the event's tool executions and duration are folded in,
 * and it fires however the caller consumes the result (`stream`,
 * `toUIMessageStream`, the result promises, or `generate`). The hook goes
 * last: the SDK runs integration hooks in order, and the host's own
 * (evlog's) hooks are synchronous, so the event is complete by the time it
 * settles.
 */
function observedCall(
  observation: TurnObservation,
  model: AgentModel
): CallSettings {
  const { integrations } = observation.telemetry;
  const settle: Telemetry = {
    onAbort: () => observation.emit(),
    onEnd: () => observation.emit(),
    onError: (event) => observation.emit(errorOf(event)),
  };
  const telemetry: TelemetryOptions = {
    ...observation.telemetry,
    integrations: [
      ...(Array.isArray(integrations)
        ? integrations
        : [integrations].filter((i) => i !== undefined)),
      settle,
    ],
    // The settle rides on telemetry, so telemetry must be on.
    isEnabled: true,
  };
  return { model: observation.wrap(model), telemetry };
}

export class LoopAgent extends ToolLoopAgent<never, ToolSet> {
  readonly #model: AgentModel;
  readonly #observe: ObserveTurn | undefined;
  readonly #sessionId: string;

  constructor(settings: LoopAgentSettings, context: TurnContext) {
    const { observe, ...rest } = settings;
    super(rest);
    this.#model = settings.model;
    this.#observe = observe;
    this.#sessionId = context.sessionId;
  }

  override async stream(
    opts: LoopAgentStreamParameters
  ): Promise<StreamTextResult<ToolSet, Record<string, unknown>, never>> {
    const observation = this.#open();
    try {
      return await super.stream({
        ...opts,
        ...(observation ? observedCall(observation, this.#model) : {}),
        experimental_transform: smoothStream({
          chunking: "line", // optional: defaults to 'word'
          delayInMs: 20, // optional: defaults to 10ms
        }),
      });
    } catch (e) {
      observation?.emit(e);
      throw e;
    }
  }

  override async generate(
    opts: LoopAgentCallParameters
  ): Promise<GenerateTextResult<ToolSet, Record<string, unknown>, never>> {
    const observation = this.#open();
    try {
      return await super.generate({
        ...opts,
        ...(observation ? observedCall(observation, this.#model) : {}),
      });
    } catch (e) {
      observation?.emit(e);
      throw e;
    }
  }

  /** One call's observation — every call is its own turn. */
  #open(): TurnObservation | null {
    return (
      this.#observe?.({
        model: routeOf(this.#model),
        sessionId: this.#sessionId,
      }) ?? null
    );
  }
}
