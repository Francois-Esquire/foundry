import type {
  AgentModel,
  ObserveTurn,
  TurnObservation,
} from "@foundry/core/agents";
import { routeOf } from "@foundry/core/agents";
import type {
  AgentCallParameters,
  AgentStreamParameters,
  GenerateTextResult,
  Output,
  StreamTextResult,
  Telemetry,
  TelemetryOptions,
  TextStreamPart,
  ToolLoopAgentSettings,
  ToolSet,
} from "ai";
import { smoothStream, ToolLoopAgent } from "ai";

export type LoopAgentSettings = Omit<
  ToolLoopAgentSettings<never, ToolSet>,
  "model" | "onFinish"
> & {
  model: AgentModel;
  observe?: ObserveTurn;
  onFinish?: (result: unknown) => void;
};

type CallSettings = Pick<
  ToolLoopAgentSettings<never, ToolSet>,
  "model" | "providerOptions" | "telemetry"
>;

export type TurnSettings = Pick<
  ToolLoopAgentSettings<never, ToolSet>,
  | "activeTools"
  | "frequencyPenalty"
  | "maxOutputTokens"
  | "presencePenalty"
  | "providerOptions"
  | "reasoning"
  | "seed"
  | "stopSequences"
  | "stopWhen"
  | "temperature"
  | "toolChoice"
  | "topK"
  | "topP"
>;

export const TURN_SETTINGS = [
  "activeTools",
  "frequencyPenalty",
  "maxOutputTokens",
  "presencePenalty",
  "providerOptions",
  "reasoning",
  "seed",
  "stopSequences",
  "stopWhen",
  "temperature",
  "toolChoice",
  "topK",
  "topP",
] as const satisfies readonly (keyof TurnSettings)[];

export type TurnCallSettings<OUTPUT extends Output.Output = never> =
  TurnSettings & { output?: OUTPUT };

export type LoopAgentCallParameters<OUTPUT extends Output.Output = never> =
  AgentCallParameters<never, ToolSet> & TurnCallSettings<OUTPUT>;
export type LoopAgentStreamParameters<OUTPUT extends Output.Output = never> =
  AgentStreamParameters<never, ToolSet> & TurnCallSettings<OUTPUT>;

export interface TurnContext {
  sessionId: string;
}

function errorOf(event: unknown): unknown {
  return typeof event === "object" && event !== null && "error" in event
    ? event.error
    : event;
}

function observedCall(
  observation: TurnObservation,
  model: AgentModel
): CallSettings {
  const { integrations } = observation.telemetry;
  const settle: Telemetry = {
    onAbort: () => observation.emit(undefined, "cancelled"),
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
    isEnabled: true,
  };
  return { model: observation.wrap(model), telemetry };
}

function settleOnCancel<OUTPUT extends Output.Output>(
  result: StreamTextResult<ToolSet, Record<string, unknown>, OUTPUT>,
  observation: TurnObservation
): void {
  const prototype: object = Object.getPrototypeOf(result);
  Object.defineProperty(result, "stream", {
    configurable: true,
    get: () => {
      const reader = (
        Reflect.get(prototype, "stream", result) as typeof result.stream
      ).getReader();
      return new ReadableStream<TextStreamPart<ToolSet>>({
        cancel: (reason) => {
          observation.emit(undefined, "cancelled");
          return reader.cancel(reason);
        },
        pull: async (controller) => {
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
            } else {
              controller.enqueue(next.value);
            }
          } catch (e) {
            observation.emit(e);
            throw e;
          }
        },
      });
    },
  });
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

  override async stream<OUTPUT extends Output.Output = never>(
    opts: LoopAgentStreamParameters<OUTPUT>
  ): Promise<StreamTextResult<ToolSet, Record<string, unknown>, OUTPUT>> {
    const observation = this.#open();
    try {
      const result = (await super.stream({
        ...opts,
        ...(observation ? observedCall(observation, this.#model) : {}),
        ...(opts.output
          ? {}
          : {
              experimental_transform: smoothStream({
                chunking: "line",
                delayInMs: 20,
              }),
            }),
      })) as unknown as StreamTextResult<
        ToolSet,
        Record<string, unknown>,
        OUTPUT
      >;
      if (observation) {
        settleOnCancel(result, observation);
      }
      return result;
    } catch (e) {
      observation?.emit(e);
      throw e;
    }
  }

  override async generate<OUTPUT extends Output.Output = never>(
    opts: LoopAgentCallParameters<OUTPUT>
  ): Promise<GenerateTextResult<ToolSet, Record<string, unknown>, OUTPUT>> {
    const observation = this.#open();
    try {
      return (await super.generate({
        ...opts,
        ...(observation ? observedCall(observation, this.#model) : {}),
      })) as unknown as GenerateTextResult<
        ToolSet,
        Record<string, unknown>,
        OUTPUT
      >;
    } catch (e) {
      observation?.emit(e);
      throw e;
    }
  }

  #open(): TurnObservation | null {
    return (
      this.#observe?.({
        model: routeOf(this.#model),
        sessionId: this.#sessionId,
      }) ?? null
    );
  }
}
