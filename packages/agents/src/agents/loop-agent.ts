import type {
  AgentCallParameters,
  AgentStreamParameters,
  GenerateTextResult,
  StreamTextResult,
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
  /** Opens a per-turn observation; omit to run unobserved. */
  observe?: ObserveTurn;
  onFinish?: (result: unknown) => void;
};

export interface TurnContext {
  sessionId: string;
}

export class LoopAgent extends ToolLoopAgent<never, ToolSet> {
  readonly #observation: TurnObservation | null;

  constructor(settings: LoopAgentSettings, context: TurnContext) {
    const { model, observe, onFinish, ...rest } = settings;
    const observation =
      observe?.({ model: routeOf(model), sessionId: context.sessionId }) ??
      null;

    super({
      ...rest,
      model: observation ? observation.wrap(model) : model,
      ...(observation ? { experimental_telemetry: observation.telemetry } : {}),
      // NB: don't settle the wide event here. `onFinish` fires before the
      // telemetry integration folds tool executions + duration into the event
      // (that lands at stream close), so emitting now drops the `ai` field.
      // The settle happens when the full stream is drained (see `stream`).
      onFinish,
    });

    this.#observation = observation;
  }

  override async stream(
    opts: AgentStreamParameters<never, ToolSet>
  ): Promise<StreamTextResult<ToolSet, Record<string, unknown>, never>> {
    try {
      const result = await super.stream({
        ...opts,
        experimental_transform: smoothStream({
          chunking: "line", // optional: defaults to 'word'
          delayInMs: 20, // optional: defaults to 10ms
        }),
      });
      const observation = this.#observation;

      if (!observation) {
        return result;
      }

      const wrappedFullStream = new Proxy(result.stream, {
        get(target, prop, receiver) {
          if (prop === Symbol.asyncIterator) {
            return () => {
              const iter = target[Symbol.asyncIterator]();
              return {
                next: async () => {
                  try {
                    const result = await iter.next();
                    // Settle once the stream is exhausted — by now the telemetry
                    // integration has folded tool executions + duration in.
                    if (result.done) {
                      observation.emit();
                    }
                    return result;
                  } catch (e) {
                    observation.emit(e);
                    throw e;
                  }
                },
                return: async (value?: unknown) => {
                  try {
                    const done = await iter.return?.(value);
                    observation.emit();
                    return done ?? { done: true, value: undefined };
                  } catch (e) {
                    observation.emit(e);
                    throw e;
                  }
                },
                throw: async (e?: unknown) => {
                  try {
                    const done = await iter.throw?.(e);
                    observation.emit(e);
                    return done ?? { done: true, value: undefined };
                  } catch (err) {
                    observation.emit(err);
                    throw err;
                  }
                },
              };
            };
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Reflect.get returns any by design; Proxy is structurally transparent
          return Reflect.get(target, prop, receiver);
        },
      });

      return new Proxy(result, {
        get(target, prop, receiver) {
          if (prop === "stream") {
            return wrappedFullStream;
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Reflect.get returns any by design; Proxy is structurally transparent
          return Reflect.get(target, prop, receiver);
        },
      });
    } catch (e) {
      this.#observation?.emit(e);
      throw e;
    }
  }

  override async generate(
    opts: AgentCallParameters<never, ToolSet>
  ): Promise<GenerateTextResult<ToolSet, Record<string, unknown>, never>> {
    try {
      const result = await super.generate(opts);
      this.#observation?.emit();
      return result;
    } catch (e) {
      this.#observation?.emit(e);
      throw e;
    }
  }
}

export type LoopAgentConfig = LoopAgentSettings;

export function createLoopAgent(
  config: LoopAgentConfig,
  context: TurnContext
): LoopAgent {
  return new LoopAgent(config, context);
}
