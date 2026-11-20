import type { LanguageModelV4 } from "@ai-sdk/provider";

export function deferredLanguageModel(
  provider: string,
  modelId: string,
  open: () => Promise<LanguageModelV4>
): LanguageModelV4 {
  let model: Promise<LanguageModelV4> | undefined;
  const load = () => {
    model ??= open();
    return model;
  };
  return {
    doGenerate: async (options) => (await load()).doGenerate(options),
    doStream: async (options) => (await load()).doStream(options),
    modelId,
    provider,
    specificationVersion: "v4",
    get supportedUrls() {
      return load().then((loaded) => loaded.supportedUrls);
    },
  };
}
