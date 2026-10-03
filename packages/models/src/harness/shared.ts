import type { HarnessTurnDriver } from "@foundry/agents/harness";
import type { SessionInput } from "@foundry/agents/session";

export type DriverRun = Parameters<HarnessTurnDriver["run"]>[0];

export function inputText(input: SessionInput): string {
  if (typeof input === "string") {
    return input;
  }
  return input.parts
    .map((part) => {
      if (part.type !== "text") {
        throw new Error(
          "CLI harness input currently supports text parts only."
        );
      }
      return part.text;
    })
    .join("\n");
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Summaries describe the shape, never command strings, file contents, or credentials. */
export function inputSummary(input: unknown): string {
  return `Input fields: ${Object.keys(record(input)).sort().join(", ") || "none"}`;
}

export function eventStream<T>(): {
  stream: AsyncIterable<T>;
  push: (value: T) => void;
  close: () => void;
} {
  const items: T[] = [];
  const state: { closed: boolean } = { closed: false };
  let wake: (() => void) | undefined;
  return {
    close() {
      state.closed = true;
      wake?.();
    },
    push(value) {
      if (!state.closed) {
        items.push(value);
        wake?.();
      }
    },
    stream: {
      async *[Symbol.asyncIterator]() {
        while (!state.closed || items.length > 0) {
          if (items.length > 0) {
            yield items.shift() as T;
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      },
    },
  };
}
