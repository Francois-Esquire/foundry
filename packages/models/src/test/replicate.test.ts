import { describe, expect, it } from "vitest";

import { ModelManager } from "../manager";
import { operationsOf } from "../provider";
import { REPLICATE_DEFAULT_MODELS, replicateProvider } from "../replicate";

function withToken(apiToken?: string) {
  return new ModelManager({
    providers: [
      replicateProvider(apiToken === undefined ? {} : { config: { apiToken } }),
    ],
  });
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
  it("resolves an image model with a token", () => {
    expect(
      withToken("r8_token").resolve("image", { provider: "replicate" }).model
    ).toBe("black-forest-labs/flux-schnell");
  });

  it("refuses without a token, and stays listed as unavailable", () => {
    const models = withToken();
    expect(() => models.resolve("image", { provider: "replicate" })).toThrow(
      'Provider "replicate" is unavailable'
    );
    expect(models.providers.map((provider) => provider.available)).toEqual([
      false,
    ]);
  });
});
