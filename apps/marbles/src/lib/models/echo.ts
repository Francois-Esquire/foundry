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

type Prompt = Parameters<LanguageModelV4["doGenerate"]>[0]["prompt"];
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
      const answer = (prompt: Prompt) => {
        const input = promptText(prompt);
        const call: MockCall = {
          cwd: options?.workingDirectory,
          executor,
          prompt: input,
        };
        const output = reply(call);
        return { call, output, usage: usage(input, output) };
      };
      return new MockLanguageModelV4({
        doGenerate: ({ prompt }) => {
          const { output, usage: responseUsage } = answer(prompt);
          return Promise.resolve({
            content: [{ text: output, type: "text" }],
            finishReason: STOP,
            usage: responseUsage,
            warnings: [],
          });
        },
        doStream: ({ abortSignal, prompt }) => {
          const { call, output, usage: responseUsage } = answer(prompt);
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

/** Prints the turn it would take and answers with that same line. */
export function echoModels(
  executors: readonly TurnExecutorRef[],
  print: Print
): ModelManager {
  return mockModels(executors, ({ executor, prompt, cwd }) => {
    const where = cwd ? ` in ${cwd}` : "";
    const text = `[${executor.provider}/${executor.model}]${where} ${prompt}`;
    print(text);
    return text;
  });
}
