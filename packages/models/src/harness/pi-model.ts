import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { StreamPart } from "@foundry/agents/harness";
import { createPiDriver, type PiDriverOptions } from "./pi";

type ModelOptions = Pick<
  PiDriverOptions,
  "binPath" | "cwd" | "env" | "spawn" | "nativeTools"
>;

/** The model entry never permits native tools to bypass the caller's AI SDK tool loop. */
export function createPiModel(
  modelId: string,
  options: ModelOptions
): LanguageModelV4 {
  const doStream = async (call: LanguageModelV4CallOptions) => {
    const warnings: SharedV4Warning[] = [];
    if (call.tools?.length) {
      warnings.push({
        details:
          "Pi model calls execute native Pi tools. Custom host tools require createPiDriver and its permission callback.",
        feature: "tools",
        type: "unsupported",
      });
    }
    for (const name of [
      "maxOutputTokens",
      "temperature",
      "topP",
      "topK",
      "presencePenalty",
      "frequencyPenalty",
      "stopSequences",
      "seed",
    ] as const) {
      if (call[name] !== undefined) {
        warnings.push({
          details: "Pi manages this setting in its own runtime.",
          feature: name,
          type: "unsupported",
        });
      }
    }
    const prompt = call.prompt
      .filter((message) => message.role !== "system")
      .map((message) => {
        const text = message.content
          .map((part) => {
            if (part.type !== "text") {
              throw new Error(
                "Pi model requests support text messages only; use the native driver for tools."
              );
            }
            return part.text;
          })
          .join("\n");
        return `${message.role}: ${text}`;
      })
      .join("\n\n");
    const temporary = await mkdtemp(join(tmpdir(), "foundry-pi-"));
    const driver = createPiDriver({
      ...options,
      agentId: "model",
      instructions: call.prompt
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n"),
      modelId,
      persist: false,
      async writeExtension(source) {
        const path = join(temporary, "host.mjs");
        await writeFile(path, source);
        return path;
      },
    });
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async cancel() {
        await driver.close?.();
      },
      async start(controller) {
        const parts = modelParts();
        try {
          controller.enqueue({ type: "stream-start", warnings });
          const source = await driver.run({
            input: prompt,
            onActivity: async () => undefined,
            onSessionId: async () => undefined,
            onToolEvent: async () => undefined,
            permission: async (request) =>
              options.nativeTools?.includes(request.toolName)
                ? { behavior: "allow" }
                : {
                    behavior: "deny",
                    message: "Native tool is not enabled for this model call.",
                  },
            profile: {
              allowedTools: [...(options.nativeTools ?? [])],
              disallowedTools: [],
              maxSteps: 20,
              mode: "scheduled",
              unresolved: "deny",
            },
            question: async () => ({
              outcome: "declined",
              reason: "No interactive model-call questions.",
            }),
            ...(call.responseFormat?.type === "json"
              ? { responseFormat: call.responseFormat }
              : {}),
            sessionId: crypto.randomUUID(),
            signal: call.abortSignal ?? new AbortController().signal,
          });
          for await (const part of source) {
            for (const converted of parts(part)) {
              controller.enqueue(converted);
            }
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          await driver.close?.();
          await rm(temporary, { force: true, recursive: true });
        }
      },
    });
    return { stream };
  };
  return {
    async doGenerate(call) {
      const { stream } = await doStream(call);
      return await generatedResult(stream);
    },
    doStream,
    modelId,
    provider: "pi",
    specificationVersion: "v4",
    supportedUrls: {},
  };
}

function modelParts(): (part: StreamPart) => LanguageModelV4StreamPart[] {
  const started = new Set<string>();
  return (part) => {
    switch (part.type) {
      case "text-delta":
      case "reasoning-delta": {
        const id = `${part.type}:${part.id}`;
        const parts: LanguageModelV4StreamPart[] = [];
        if (!started.has(id)) {
          started.add(id);
          parts.push({
            id,
            type: part.type === "text-delta" ? "text-start" : "reasoning-start",
          });
        }
        parts.push({ delta: part.text, id, type: part.type });
        return parts;
      }
      case "error":
        throw part.error;
      case "abort":
        throw new Error("Pi model call interrupted.");
      case "finish": {
        const parts: LanguageModelV4StreamPart[] = [];
        for (const id of started) {
          parts.push({
            id,
            type: id.startsWith("text-") ? "text-end" : "reasoning-end",
          });
        }
        const usage = part.totalUsage;
        parts.push({
          finishReason: {
            raw: part.rawFinishReason,
            unified: part.finishReason,
          },
          type: "finish",
          usage: {
            inputTokens: {
              cacheRead: usage.inputTokenDetails.cacheReadTokens,
              cacheWrite: usage.inputTokenDetails.cacheWriteTokens,
              noCache: usage.inputTokenDetails.noCacheTokens,
              total: usage.inputTokens,
            },
            outputTokens: {
              reasoning: usage.outputTokenDetails.reasoningTokens,
              text: usage.outputTokenDetails.textTokens,
              total: usage.outputTokens,
            },
          },
        });
        return parts;
      }
      default:
        return [];
    }
  };
}

async function generatedResult(
  stream: ReadableStream<LanguageModelV4StreamPart>
): Promise<LanguageModelV4GenerateResult> {
  const reader = stream.getReader();
  const content: LanguageModelV4GenerateResult["content"] = [];
  let finish:
    | Extract<LanguageModelV4StreamPart, { type: "finish" }>
    | undefined;
  const warnings: SharedV4Warning[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const part = next.value;
      switch (part.type) {
        case "text-delta":
          content.push({ text: part.delta, type: "text" });
          break;
        case "reasoning-delta":
          content.push({ text: part.delta, type: "reasoning" });
          break;
        case "finish":
          finish = part;
          break;
        case "stream-start":
          warnings.push(...part.warnings);
          break;
        default:
          break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!finish) {
    throw new Error("Pi model call ended without completion.");
  }
  return {
    content,
    finishReason: finish.finishReason,
    usage: finish.usage,
    warnings,
  };
}
