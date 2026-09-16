import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { AgentModel, ModelLimits, ModelRoute } from "../../agents/model";

type GenerateResult = Awaited<
  ReturnType<InstanceType<typeof MockLanguageModelV4>["doGenerate"]>
>;
type StreamResult = Awaited<
  ReturnType<InstanceType<typeof MockLanguageModelV4>["doStream"]>
>;
type FinishReason = GenerateResult["finishReason"];
type Usage = GenerateResult["usage"];

const emptyUsage: Usage = {
  inputTokens: {
    cacheRead: 0,
    cacheWrite: 0,
    noCache: 0,
    total: 0,
  },
  outputTokens: {
    reasoning: 0,
    text: 0,
    total: 0,
  },
};

const stopReason: FinishReason = {
  raw: undefined,
  unified: "stop",
};

const toolCallsReason: FinishReason = {
  raw: undefined,
  unified: "tool-calls",
};

export function textGenerateResult(text: string): GenerateResult {
  return {
    content: [{ text, type: "text" }],
    finishReason: stopReason,
    usage: emptyUsage,
    warnings: [],
  };
}

export function toolCallGenerateResult(
  toolCallId: string,
  toolName: string,
  input: unknown
): GenerateResult {
  return {
    content: [
      {
        input: JSON.stringify(input),
        toolCallId,
        toolName,
        type: "tool-call",
      },
    ],
    finishReason: toolCallsReason,
    usage: emptyUsage,
    warnings: [],
  };
}

/** Build a nested LanguageModelV4 usage from plain input/output token counts. */
export function mkUsage(inputTokens: number, outputTokens: number): Usage {
  return {
    inputTokens: {
      cacheRead: 0,
      cacheWrite: 0,
      noCache: inputTokens,
      total: inputTokens,
    },
    outputTokens: { reasoning: 0, text: outputTokens, total: outputTokens },
  };
}

export function toolCallStreamResult(
  toolCallId: string,
  toolName: string,
  input: unknown,
  usage: Usage = emptyUsage
): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          input: JSON.stringify(input),
          toolCallId,
          toolName,
          type: "tool-call",
        },
        {
          finishReason: toolCallsReason,
          type: "finish",
          usage,
        },
      ],
    }),
  };
}

export function textStreamResult(text: string): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { id: "text-1", type: "text-start" },
        { delta: text, id: "text-1", type: "text-delta" },
        { id: "text-1", type: "text-end" },
        {
          finishReason: stopReason,
          type: "finish",
          usage: emptyUsage,
        },
      ],
    }),
  };
}

export function usageStreamResult(
  text: string,
  inputTokens: number,
  outputTokens: number
): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { id: "text-1", type: "text-start" },
        { delta: text, id: "text-1", type: "text-delta" },
        { id: "text-1", type: "text-end" },
        {
          finishReason: stopReason,
          type: "finish",
          usage: {
            inputTokens: {
              cacheRead: 0,
              cacheWrite: 0,
              noCache: inputTokens,
              total: inputTokens,
            },
            outputTokens: {
              reasoning: 0,
              text: outputTokens,
              total: outputTokens,
            },
          },
        },
      ],
    }),
  };
}

export function reasoningStreamResult(
  reasoning: string,
  text: string
): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { id: "reasoning-1", type: "reasoning-start" },
        { delta: reasoning, id: "reasoning-1", type: "reasoning-delta" },
        { id: "reasoning-1", type: "reasoning-end" },
        { id: "text-1", type: "text-start" },
        { delta: text, id: "text-1", type: "text-delta" },
        { id: "text-1", type: "text-end" },
        {
          finishReason: stopReason,
          type: "finish",
          usage: emptyUsage,
        },
      ],
    }),
  };
}

function scriptResponses<T>(responses: T[]): () => T {
  let step = 0;
  return () => {
    const response = responses[step];
    step += 1;
    if (response === undefined) {
      throw new Error(`No mock response scripted for step ${step}`);
    }
    return response;
  };
}

export function createScriptedMockModel(options: {
  generate?: GenerateResult[];
  stream?: StreamResult[];
}): MockLanguageModelV4 {
  const generate = options.generate ?? [textGenerateResult("")];
  const stream = options.stream ?? [textStreamResult("")];
  const nextGenerate = scriptResponses(generate);
  const nextStream = scriptResponses(stream);

  return new MockLanguageModelV4({
    doGenerate: () => Promise.resolve(nextGenerate()),
    doStream: () => Promise.resolve(nextStream()),
  });
}

/** A model that declares its route and limits, as a host registry would. */
export function routed(
  model: MockLanguageModelV4,
  route: ModelRoute,
  limits?: ModelLimits
): AgentModel {
  return Object.assign(model, { route, ...(limits ? { limits } : {}) });
}

export type { GenerateResult, StreamResult };
