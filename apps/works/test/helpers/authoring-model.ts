import { ModelManager, type Provider } from "@foundry.sh/marbles/engine";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

type LanguageModelV4StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4["doStream"]>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/**
 * One model call: tools the model asks for, or its closing text. `wait`
 * holds the call until it resolves, so a journey can line other work up
 * with the turn.
 */
export type ScriptedStep =
  | {
      readonly tools: readonly { name: string; input: unknown }[];
      readonly wait?: () => Promise<void>;
    }
  | { readonly text: string }
  | { readonly hold: true };

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

function chunks(step: ScriptedStep, call: number): LanguageModelV4StreamPart[] {
  if ("tools" in step) {
    return [
      ...step.tools.map(
        (tool, index): LanguageModelV4StreamPart => ({
          input: JSON.stringify(tool.input),
          toolCallId: `call-${call}-${index}`,
          toolName: tool.name,
          type: "tool-call",
        })
      ),
      {
        finishReason: { raw: undefined, unified: "tool-calls" },
        type: "finish",
        usage,
      },
    ];
  }
  const text = "text" in step ? step.text : "";
  return [
    { id: "text", type: "text-start" },
    { delta: text, id: "text", type: "text-delta" },
    { id: "text", type: "text-end" },
    {
      finishReason: { raw: undefined, unified: "stop" },
      type: "finish",
      usage,
    },
  ];
}

/**
 * A deterministic provider: every model call takes the next step of the
 * script, and a `hold` step streams nothing until its call is aborted.
 */
export function scriptedModels(script: ScriptedStep[]) {
  const { prompts, provider } = scriptedProvider(script);
  return { models: new ModelManager({ providers: [provider] }), prompts };
}

/**
 * The scripted provider behind a credential binding, as the Gateway and
 * Vercel bindings are: it exists only once `configure` hands it a Gateway
 * key, and `keys` lists each key it was created or updated with.
 */
export function credentialedScriptedModels(script: ScriptedStep[]) {
  const { prompts, provider } = scriptedProvider(script);
  const keys: string[] = [];
  const models = new ModelManager({
    bindings: [
      {
        create(key: string) {
          keys.push(key);
          return provider;
        },
        fromCredentials: (credentials) => credentials.aiGatewayApiKey ?? null,
        id: provider.id,
        update(_provider, key: string) {
          keys.push(key);
        },
      },
    ],
  });
  return { keys, models, prompts };
}

function scriptedProvider(script: ScriptedStep[]) {
  let call = 0;
  const prompts: unknown[] = [];
  const provider: Provider = {
    available: true,
    harness: "studio",
    id: "scripted",
    languageModel: () =>
      new MockLanguageModelV4({
        doStream: async ({ abortSignal, prompt }) => {
          prompts.push(prompt);
          const step = script[call] ?? { text: "Done." };
          call += 1;
          if ("tools" in step) {
            await step.wait?.();
          }
          if ("hold" in step) {
            return {
              stream: new ReadableStream<LanguageModelV4StreamPart>({
                start(controller) {
                  abortSignal?.addEventListener(
                    "abort",
                    () => controller.error(abortSignal.reason),
                    { once: true }
                  );
                },
              }),
            };
          }
          return {
            stream: simulateReadableStream({ chunks: chunks(step, call) }),
          };
        },
      }),
    models: [{ id: "scripted/coder", kind: "text", modelId: "coder" }],
    offline: false,
  };
  return { prompts, provider };
}
