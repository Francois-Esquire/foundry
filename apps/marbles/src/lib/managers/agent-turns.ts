import type {
  HarnessSession,
  SessionHarness,
  TurnOptions,
} from "@foundry/agents/harness";
import type {
  SessionEvent,
  SessionInput,
  SessionMessage,
  SessionStream,
  SessionUsage,
} from "@foundry/agents/session";
import type { InferGenerateOutput, InferStreamOutput, Output } from "ai";
import type { RecordObservation } from "../observations";
import { toolObserver } from "../observations";
import type { StepWork } from "../step-work";
import type {
  AgentSettings,
  Session,
  SessionRef,
  SessionReply,
} from "../types";

export interface LiveSession {
  readonly ref: SessionRef;
  running?: Promise<unknown>;
  steer?: string;
  turn?: AbortController;
}

export interface SessionTurnSite {
  readonly agent?: string;
  consumed?(
    message: SessionMessage,
    usage?: SessionUsage
  ): Promise<void> | void;
  readonly observe?: RecordObservation;
  readonly recorded?: SessionRef;
  signal(): AbortSignal;
  takeResume(): string | undefined;
  track(live: LiveSession): void;
  readonly work?: StepWork;
  write(value: unknown): void;
}

function endOf(message: SessionReply<Output.Output>): SessionEvent {
  if (message.status === "complete") {
    return { message, type: "finish", usage: message.usage };
  }
  const failure = message.parts.findLast((part) => part.type === "error");
  return {
    error: new Error(
      failure?.type === "error" ? failure.message : "The turn failed."
    ),
    type: "error",
  };
}

function textOf(message: SessionMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

export function replyOf<OUTPUT extends Output.Output>(
  message: SessionMessage
): SessionReply<OUTPUT> {
  return {
    ...message,
    output: message.metadata?.output as InferGenerateOutput<OUTPUT>,
    text: textOf(message),
    usage: message.metadata?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

export function replayedStream<OUTPUT extends Output.Output>(
  reply: SessionReply<OUTPUT>
): SessionStream<OUTPUT> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* [endOf(reply)];
    },
    message: Promise.resolve(reply),
    outcome: Promise.resolve("complete"),
    output: Promise.resolve(reply.output),
    partialOutputStream: (async function* () {
      yield* [];
    })(),
    result: Promise.resolve(undefined),
    text: Promise.resolve(reply.text),
    usage: Promise.resolve(reply.usage),
  };
}

export function deferredStream<OUTPUT extends Output.Output>(
  opening: Promise<SessionStream<OUTPUT>>
): SessionStream<OUTPUT> {
  const final = <T>(pick: (stream: SessionStream<OUTPUT>) => Promise<T>) => {
    const value = opening.then(pick);
    value.catch(() => undefined);
    return value;
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield* await opening;
    },
    message: final((stream) => stream.message),
    outcome: final((stream) => stream.outcome),
    output: final((stream) => stream.output),
    partialOutputStream: {
      async *[Symbol.asyncIterator]() {
        yield* (await opening).partialOutputStream;
      },
    },
    result: final((stream) => stream.result),
    text: final((stream) => stream.text),
    usage: final((stream) => stream.usage),
  };
}

export function wrapAgentSession<DEFAULT extends Output.Output = never>(
  harness: SessionHarness | HarnessSession,
  ref: SessionRef,
  site: SessionTurnSite,
  settings: AgentSettings<DEFAULT> = {}
): Session<DEFAULT> {
  const live: LiveSession = { ref };
  site.track(live);
  const check = () => site.signal().throwIfAborted();
  const withResume = (input: SessionInput): SessionInput => {
    if (!(site.recorded && typeof input === "string")) {
      return input;
    }
    const prompt = site.takeResume();
    if (prompt === undefined) {
      return input;
    }
    site.write(`\n[resume] ${prompt}\n`);
    return `${prompt}\n\n${input}`;
  };
  const stream = <OUTPUT extends Output.Output = DEFAULT>(
    input: SessionInput,
    turnOptions?: TurnOptions<OUTPUT>
  ): SessionStream<OUTPUT> => {
    const options = { ...settings, ...turnOptions } as TurnOptions<OUTPUT>;
    check();
    if (live.turn !== undefined) {
      throw new Error("A session can run only one turn at a time.");
    }
    const ended = site.work?.begin({
      ...(site.agent === undefined ? {} : { agent: site.agent }),
      kind: "agent",
      ...(ref.model === undefined ? {} : { model: ref.model }),
      ...(ref.provider === undefined ? {} : { provider: ref.provider }),
      sessionId: ref.id,
      steer: (prompt) => {
        live.steer = prompt;
        live.turn?.abort(new Error("steered"));
      },
    });
    let nextInput = withResume(input);
    let controller!: ReadableStreamDefaultController<SessionEvent>;
    const events = new ReadableStream<SessionEvent>({
      start(value) {
        controller = value;
      },
    });
    let partialController!: ReadableStreamDefaultController<
      InferStreamOutput<OUTPUT>
    >;
    const partials = new ReadableStream<InferStreamOutput<OUTPUT>>({
      start(value) {
        partialController = value;
      },
    });
    const openTurn = (next: SessionInput) => {
      const turn = new AbortController();
      live.turn = turn;
      return harness.stream(next, {
        ...options,
        onText: (delta) => {
          site.write(delta);
          options?.onText?.(delta);
        },
        signal: AbortSignal.any([
          site.signal(),
          turn.signal,
          ...(options?.signal ? [options.signal] : []),
        ]),
      });
    };
    const tools = site.observe ? toolObserver(site.observe, ref.id) : undefined;
    const publishEvents = async (current: SessionStream<OUTPUT>) => {
      const publishPartials = (async () => {
        for await (const partial of current.partialOutputStream) {
          partialController.enqueue(partial);
        }
      })();
      publishPartials.catch(() => undefined);
      for await (const event of current) {
        tools?.event(event);
        if (
          event.type !== "finish" &&
          !(event.type === "error" && live.steer !== undefined)
        ) {
          controller.enqueue(event);
        }
      }
      await publishPartials;
    };
    const run = async () => {
      try {
        for (;;) {
          check();
          const current = openTurn(nextInput);
          await publishEvents(current);
          const message = await current.message;
          if (live.steer !== undefined || site.signal().aborted) {
            await site.consumed?.(message);
          }
          check();
          if (live.steer !== undefined) {
            nextInput = live.steer;
            live.steer = undefined;
            site.write(`\n[steer] ${nextInput}\n`);
            continue;
          }
          ended?.();
          const outcome = await current.outcome;
          const usage = await current.usage;
          await site.consumed?.(message, usage);
          if (message.status === "complete") {
            controller.enqueue({ message, type: "finish", usage });
          }
          controller.close();
          partialController.close();
          return { current, message, outcome, usage };
        }
      } catch (error) {
        controller.error(error);
        partialController.error(error);
        throw error;
      } finally {
        ended?.();
        tools?.end();
        live.turn = undefined;
        live.steer = undefined;
      }
    };
    const turns = run();
    live.running = turns;
    turns
      .finally(() => {
        if (live.running === turns) {
          live.running = undefined;
        }
      })
      .catch(() => undefined);
    const message = turns.then((value) => value.message);
    const outcome = turns.then((value) => value.outcome);
    const output = turns.then((value) => value.current.output);
    const result = turns.then((value) => value.current.result);
    const text = message.then(textOf);
    const usage = turns.then((value) => value.usage);
    for (const final of [message, outcome, output, result, text, usage]) {
      final.catch(() => undefined);
    }
    return {
      [Symbol.asyncIterator]: () => events.values({ preventCancel: true }),
      message,
      outcome,
      output,
      partialOutputStream: partials.values({ preventCancel: true }),
      result,
      text,
      usage,
    };
  };
  return {
    async generate(input, options) {
      const turn = stream(input, options);
      const message = await turn.message;
      const [output, usage, result] = await Promise.all([
        turn.output,
        turn.usage,
        turn.result,
      ]);
      return {
        ...message,
        output,
        ...(result ? { result } : {}),
        text: textOf(message),
        usage,
      };
    },
    harness,
    ref,
    stream,
  };
}
