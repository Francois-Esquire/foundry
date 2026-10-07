import type {
  HarnessSession,
  SessionHarness,
  SessionStreamOptions,
} from "@foundry/agents/harness";
import type {
  SessionEvent,
  SessionInput,
  SessionMessage,
  SessionStream,
} from "@foundry/agents/session";
import type { LiveSession } from "../run-scope";
import type { Session, SessionRef } from "../types";

export interface SessionTurnSite {
  readonly recorded?: SessionRef;
  signal(): AbortSignal;
  takeResume(): string | undefined;
  track(live: LiveSession): void;
  write(value: unknown): void;
}

function textOf(message: SessionMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/** One turn controller for collected and streamed replies, including every steering continuation. */
export function wrapAgentSession(
  harness: SessionHarness | HarnessSession,
  ref: SessionRef,
  site: SessionTurnSite
): Session {
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
  const stream = (
    input: SessionInput,
    options?: SessionStreamOptions
  ): SessionStream => {
    check();
    if (live.turn !== undefined) {
      throw new Error("A session can run only one turn at a time.");
    }
    let nextInput = withResume(input);
    // The producer runs even when a caller only awaits a final promise.
    // Iteration observes all turns; final promises describe the last turn.
    let controller!: ReadableStreamDefaultController<SessionEvent>;
    const events = new ReadableStream<SessionEvent>({
      start(value) {
        controller = value;
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
    const publishEvents = async (current: SessionStream) => {
      for await (const event of current) {
        if (
          event.type !== "finish" &&
          !(event.type === "error" && live.steer !== undefined)
        ) {
          controller.enqueue(event);
        }
      }
    };
    const run = async () => {
      try {
        for (;;) {
          check();
          const current = openTurn(nextInput);
          await publishEvents(current);
          const message = await current.message;
          check();
          if (live.steer !== undefined) {
            nextInput = live.steer;
            live.steer = undefined;
            site.write(`\n[steer] ${nextInput}\n`);
            continue;
          }
          const outcome = await current.outcome;
          const usage = await current.usage;
          controller.enqueue({ message, type: "finish", usage });
          controller.close();
          return { message, outcome, usage };
        }
      } catch (error) {
        controller.error(error);
        throw error;
      } finally {
        live.turn = undefined;
        live.steer = undefined;
      }
    };
    const result = run();
    const message = result.then((value) => value.message);
    const outcome = result.then((value) => value.outcome);
    const text = message.then(textOf);
    const usage = result.then((value) => value.usage);
    for (const final of [message, outcome, text, usage]) {
      final.catch(() => undefined);
    }
    return {
      [Symbol.asyncIterator]: () => events.values({ preventCancel: true }),
      message,
      outcome,
      text,
      usage,
    };
  };
  return {
    async generate(input, options) {
      const message = await stream(input, options).message;
      return { ...message, text: textOf(message) };
    },
    harness,
    ref,
    stream,
  };
}
