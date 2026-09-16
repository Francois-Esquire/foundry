import { describe, expect, it } from "vitest";

import { ModelManager } from "../manager";
import { operationsOf } from "../provider";
import { REPLICATE_DEFAULT_MODELS, replicateProvider } from "../replicate";

function withToken(apiToken?: string) {
  const manager = new ModelManager();
  manager.register(
    replicateProvider(apiToken === undefined ? {} : { config: { apiToken } })
  );
  return manager;
}

describe("Replicate catalog facts", () => {
  it("declares every fact explicitly, with required inside inputs and a MIME", () => {
    for (const row of REPLICATE_DEFAULT_MODELS) {
      expect(row.operations, `${row.id} declares no facts`).toBeDefined();
      for (const fact of operationsOf(row)) {
        expect(fact.mode).toBe("request");
        for (const form of fact.required) {
          expect(fact.inputs, `${row.id} ${fact.operation}`).toContain(form);
        }
        expect(fact.outputs.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("declares facts only for the kinds the adapter serves", () => {
    const provider = replicateProvider();
    expect(typeof provider.imageModel).toBe("function");
    expect(typeof provider.videoModel).toBe("function");
    expect(typeof provider.speechModel).toBe("undefined");
    expect(typeof provider.transcriptionModel).toBe("undefined");
    expect(typeof provider.mediaModel).toBe("undefined");
    expect(
      REPLICATE_DEFAULT_MODELS.flatMap((row) =>
        operationsOf(row).map((fact) => fact.operation)
      ).sort()
    ).toEqual(["generate-image", "generate-video"]);
  });
});

describe("Replicate availability", () => {
  it("selects generate-image with a token", () => {
    const selection = withToken("r8_token").select("generate-image", {
      provider: "replicate",
    });
    expect(selection.model.id).toBe("black-forest-labs/flux-schnell");
    expect(selection.fact.outputs[0]).toBe("image/webp");
  });

  it("refuses NO_USABLE_PROVIDER without a token", () => {
    expect(() =>
      withToken().select("generate-image", { provider: "replicate" })
    ).toThrow(/No credentialed provider/);
  });

  it("stays in offers while registered without a token", () => {
    const offers = withToken().offers("generate-video");
    expect(offers.map((offer) => offer.provider)).toEqual(["replicate"]);
    expect(offers[0]?.available).toBe(false);
    expect(offers[0]?.fact.outputs[0]).toBe("video/mp4");
  });

  it("recomputes Availability on configure", () => {
    const provider = replicateProvider();
    expect(provider.available).toBe(false);
    provider.configure?.({ apiToken: "r8_token" });
    expect(provider.available).toBe(true);
    provider.configure?.({ apiToken: undefined });
    expect(provider.available).toBe(false);
  });
});
