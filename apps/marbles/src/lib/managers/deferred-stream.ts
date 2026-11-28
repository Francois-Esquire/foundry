import type { SessionStream } from "@foundry/agents/session";
import type { Output } from "ai";

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
