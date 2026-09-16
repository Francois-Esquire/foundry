import type { ProviderV4 } from "@ai-sdk/provider";

import { describe, expect, it } from "vitest";
import { fromSdk, operationsOf } from "../provider";
import type { ModelKind, OperationName } from "../types";

const DERIVED: [ModelKind, { operation: OperationName; mime: string }[]][] = [
  [
    "text",
    [
      { mime: "text/markdown", operation: "generate-text" },
      { mime: "text/markdown", operation: "reformat-text" },
    ],
  ],
  ["image", [{ mime: "image/png", operation: "generate-image" }]],
  ["video", [{ mime: "video/mp4", operation: "generate-video" }]],
  ["speech", [{ mime: "audio/mpeg", operation: "generate-speech" }]],
  ["transcription", [{ mime: "text/plain", operation: "transcribe" }]],
  ["embedding", []],
  ["music", []],
  ["sound", []],
  ["segmentation", []],
];

describe("operationsOf", () => {
  it.each(DERIVED)("derives %s facts from Kind alone", (kind, expected) => {
    const facts = operationsOf({ id: "row", kind, modelId: "wire" });
    expect(facts.map((fact) => fact.operation)).toEqual(
      expected.map((row) => row.operation)
    );
    for (const [index, fact] of facts.entries()) {
      expect(fact.mode).toBe("request");
      expect(fact.delivery).toBe("whole");
      expect(fact.outputs).toEqual([expected[index]?.mime]);
    }
  });

  it("treats a row without a kind as text, matching resolveDefinition", () => {
    expect(
      operationsOf({ id: "row", modelId: "wire" }).map((f) => f.operation)
    ).toEqual(["generate-text", "reformat-text"]);
  });

  it("keeps required a subset of inputs on every derived fact", () => {
    for (const [kind] of DERIVED) {
      for (const fact of operationsOf({ id: "row", kind, modelId: "wire" })) {
        for (const required of fact.required) {
          expect(fact.inputs).toContain(required);
        }
      }
    }
  });

  it("lets explicit operations win over the row's Kind", () => {
    const facts = operationsOf({
      id: "row",
      kind: "embedding",
      modelId: "wire",
      operations: [
        {
          delivery: "whole",
          inputs: ["source-image", "segmentation-prompt"],
          mode: "request",
          operation: "segment-image",
          outputs: ["application/vnd.foundry.segmentation+json"],
          required: ["source-image"],
        },
      ],
    });
    expect(facts.map((fact) => fact.operation)).toEqual(["segment-image"]);
  });
});

const META = {
  available: true,
  harness: "studio",
  id: "sdk",
  models: [],
  offline: false,
};

const BASE_SDK = {
  embeddingModel: () => ({}) as never,
  imageModel: () => ({}) as never,
  languageModel: () => ({}) as never,
  specificationVersion: "v4",
} satisfies ProviderV4;

describe("fromSdk", () => {
  it("forwards videoModel when the SDK object implements it", () => {
    const provider = fromSdk(META, {
      ...BASE_SDK,
      videoModel: (modelId) => ({ modelId }) as never,
    });
    expect(provider.videoModel?.("wire")).toEqual({ modelId: "wire" });
  });

  it("leaves videoModel absent when the SDK object has none", () => {
    expect("videoModel" in fromSdk(META, BASE_SDK)).toBe(false);
  });
});
