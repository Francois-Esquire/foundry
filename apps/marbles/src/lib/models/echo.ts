import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider";
import type {
  LanguageModelV4,
  Provider,
  TurnExecutorRef,
} from "@foundry/models";
import { ModelManager } from "@foundry/models";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/**
 * `--dry-run` lives inside the ModelManager: one echo provider per executor, so a
 * config that calls `models.model(...)` runs unchanged and spends nothing.
 */

export type Print = (line: string) => void;

type CallOptions = Parameters<LanguageModelV4["doGenerate"]>[0];
type Prompt = CallOptions["prompt"];
type Generated = Awaited<ReturnType<LanguageModelV4["doGenerate"]>>;

const STOP: Generated["finishReason"] = { raw: undefined, unified: "stop" };

/** Reported usage drives compaction, so the mock estimates rather than zeroes. */
function usage(input: string, output: string): Generated["usage"] {
  const tokens = (text: string) => Math.ceil(text.length / 4);
  return {
    inputTokens: {
      cacheRead: 0,
      cacheWrite: 0,
      noCache: tokens(input),
      total: tokens(input),
    },
    outputTokens: { reasoning: 0, text: tokens(output), total: tokens(output) },
  };
}

interface MockCall {
  readonly cwd: string | undefined;
  readonly executor: TurnExecutorRef;
  readonly prompt: string;
  /** The JSON schema the turn's structured output must match, if any. */
  readonly schema?: JSONSchema7;
}

/** Decides the text a mock model answers with. */
export type Reply = (call: MockCall) => string;

export interface MockOptions {
  /**
   * When it returns true the streamed turn sends its first word and then
   * waits for the turn's abort signal before finishing, so a test can act
   * on a turn that is still running.
   */
  readonly hold?: (call: MockCall) => boolean;
}

function heldStream(
  output: string,
  responseUsage: Generated["usage"],
  abortSignal: AbortSignal | undefined
): ReadableStream<unknown> {
  const [first = "", ...rest] = output.split(" ");
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ id: "text-1", type: "text-start" });
      controller.enqueue({ delta: first, id: "text-1", type: "text-delta" });
      const finish = () => {
        controller.enqueue({
          delta: rest.length > 0 ? ` ${rest.join(" ")}` : "",
          id: "text-1",
          type: "text-delta",
        });
        controller.enqueue({ id: "text-1", type: "text-end" });
        controller.enqueue({
          finishReason: STOP,
          type: "finish",
          usage: responseUsage,
        });
        controller.close();
      };
      if (!abortSignal || abortSignal.aborted) {
        finish();
        return;
      }
      abortSignal.addEventListener("abort", finish, { once: true });
    },
  });
}

function promptText(prompt: Prompt): string {
  return prompt
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text" ? [part.text] : []
          )
    )
    .join("\n");
}

function mockProvider(
  executor: TurnExecutorRef,
  reply: Reply,
  mockOptions: MockOptions
): Provider {
  return {
    available: true,
    harness: executor.harness,
    id: executor.provider,
    languageModel: (_modelId, options) => {
      const answer = ({ prompt, responseFormat }: CallOptions) => {
        const input = promptText(prompt);
        const call: MockCall = {
          cwd: options?.workingDirectory,
          executor,
          prompt: input,
          ...(responseFormat?.type === "json" && responseFormat.schema
            ? { schema: responseFormat.schema }
            : {}),
        };
        const output = reply(call);
        return { call, output, usage: usage(input, output) };
      };
      return new MockLanguageModelV4({
        doGenerate: (call) => {
          const { output, usage: responseUsage } = answer(call);
          return Promise.resolve({
            content: [{ text: output, type: "text" }],
            finishReason: STOP,
            usage: responseUsage,
            warnings: [],
          });
        },
        doStream: (streamCall) => {
          const { abortSignal } = streamCall;
          const { call, output, usage: responseUsage } = answer(streamCall);
          if (mockOptions.hold?.(call)) {
            return Promise.resolve({
              stream: heldStream(output, responseUsage, abortSignal) as never,
            });
          }
          return Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { id: "text-1", type: "text-start" },
                { delta: output, id: "text-1", type: "text-delta" },
                { id: "text-1", type: "text-end" },
                { finishReason: STOP, type: "finish", usage: responseUsage },
              ],
            }),
          });
        },
      });
    },
    models: [{ id: executor.model, kind: "text", modelId: executor.model }],
    offline: true,
  };
}

export function mockModels(
  executors: readonly TurnExecutorRef[],
  reply: Reply,
  options: MockOptions = {}
): ModelManager {
  return new ModelManager({
    providers: executors.map((executor) =>
      mockProvider(executor, reply, options)
    ),
  });
}

/**
 * Prints the turn it would take and answers with that same line. A turn
 * with structured output is answered with the smallest value its schema
 * accepts, and the line names the keys it asked for.
 */
export function echoModels(
  executors: readonly TurnExecutorRef[],
  print: Print
): ModelManager {
  return mockModels(executors, ({ executor, prompt, cwd, schema }) => {
    const where = cwd ? ` in ${cwd}` : "";
    const text = `[${executor.provider}/${executor.model}]${where} ${prompt}`;
    if (!schema) {
      print(text);
      return text;
    }
    const keys = Object.keys(schema.properties ?? {});
    print(`${text} → ${keys.length > 0 ? `{ ${keys.join(", ")} }` : "json"}`);
    return JSON.stringify(sampleOf(schema));
  });
}

/**
 * The smallest value a schema accepts: required keys only, empty arrays
 * (or the fewest items allowed), the first enum member, the lowest number.
 */
function sampleOf(definition: JSONSchema7Definition): unknown {
  if (typeof definition === "boolean") {
    return definition ? {} : null;
  }
  if (definition.const !== undefined) {
    return definition.const;
  }
  if (definition.enum?.length) {
    return definition.enum[0];
  }
  const alternative = definition.anyOf?.[0] ?? definition.oneOf?.[0];
  if (alternative !== undefined) {
    return sampleOf(alternative);
  }
  const types = [definition.type ?? []].flat();
  const type = types.find((name) => name !== "null") ?? types[0];
  switch (type) {
    case "object": {
      const required = new Set(definition.required);
      return Object.fromEntries(
        Object.entries(definition.properties ?? {})
          .filter(([name]) => required.has(name))
          .map(([name, property]) => [name, sampleOf(property)])
      );
    }
    case "array": {
      const { items = {}, minItems = 0 } = definition;
      const tuple = Array.isArray(items)
        ? items
        : Array.from({ length: minItems }, () => items);
      return tuple.map((item) => sampleOf(item));
    }
    case "string":
      return "x".repeat(definition.minLength ?? 0);
    case "number":
    case "integer":
      if (definition.minimum !== undefined) {
        return definition.minimum;
      }
      return definition.exclusiveMinimum === undefined
        ? 0
        : definition.exclusiveMinimum + 1;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return definition.allOf?.[0] === undefined
        ? {}
        : sampleOf(definition.allOf[0]);
  }
}
