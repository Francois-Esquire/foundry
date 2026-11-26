import type { ProviderV4 } from "@ai-sdk/provider";

import { describe, expect, it } from "vitest";
import { fromSdk } from "../provider";

const META = {
  available: true,
  id: "sdk",
  models: [],
};

const BASE_SDK = {
  embeddingModel: (modelId: string) => ({ modelId }) as never,
  imageModel: (modelId: string) => ({ modelId }) as never,
  languageModel: (modelId: string) => ({ modelId }) as never,
  specificationVersion: "v4",
} satisfies ProviderV4;

describe("fromSdk", () => {
  it("forwards each model method to the SDK object", () => {
    const provider = fromSdk(META, BASE_SDK);
    expect(provider.languageModel("text")).toEqual({ modelId: "text" });
    expect(provider.embeddingModel?.("embed")).toEqual({ modelId: "embed" });
    expect(provider.imageModel?.("image")).toEqual({ modelId: "image" });
  });
});
