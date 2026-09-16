import { describe, expect, it, vi } from "vitest";

import type * as LoggerModule from "../logger";
import type { CapabilityFact, ProviderModelDefinition } from "../types";

vi.mock("../logger", async (orig) => {
  const actual = await orig<typeof LoggerModule>();
  return {
    ...actual,
    configureModelObservability: vi.fn(actual.configureModelObservability),
  };
});

const { configureModelObservability } = await import("../logger");
const { ModelManager } = await import("../manager");
const { fakeProvider } = await import("./helpers/model");

const MUSIC_FACT: CapabilityFact = {
  delivery: "whole",
  inputs: ["direction"],
  mode: "request",
  operation: "generate-music",
  outputs: ["audio/mpeg"],
  required: ["direction"],
};

const MUSIC_ROW: ProviderModelDefinition = {
  id: "tune",
  kind: "music",
  modelId: "upstream/tune",
  operations: [MUSIC_FACT],
};

describe("offers", () => {
  it("lists a registered but uncredentialed provider as unavailable", () => {
    const credentialed = fakeProvider("fixture-a", {
      defaults: {},
      models: [{ ...MUSIC_ROW, price: { unit: "second", usd: 0.01 } }],
    });
    const uncredentialed = fakeProvider("fixture-b", {
      available: false,
      defaults: {},
      models: [MUSIC_ROW],
    });
    const manager = new ModelManager({
      providers: [credentialed, uncredentialed],
    });

    const rows = manager.offers("generate-music");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ available: true, provider: "fixture-a" });
    expect(rows[0]?.model.price).toEqual({ unit: "second", usd: 0.01 });
    expect(rows[1]).toMatchObject({ available: false, provider: "fixture-b" });
    expect(rows[1]?.model.price).toBeUndefined();
  });

  it("lists every fact when no operation is named, derived ones included", () => {
    const manager = new ModelManager({
      providers: [
        fakeProvider("fixture", {
          defaults: {},
          models: [
            MUSIC_ROW,
            { id: "smart", kind: "text", modelId: "upstream/smart" },
            { id: "embed", kind: "embedding", modelId: "upstream/embed" },
          ],
        }),
      ],
    });

    expect(manager.offers().map((offer) => offer.fact.operation)).toEqual([
      "generate-music",
      "generate-text",
      "reformat-text",
    ]);
  });

  it("is empty when nothing bears the fact", () => {
    const manager = new ModelManager({
      providers: [
        fakeProvider("fixture", {
          defaults: {},
          models: [
            { id: "embed", kind: "embedding", modelId: "upstream/embed" },
          ],
        }),
      ],
    });
    expect(manager.offers("generate-image")).toEqual([]);
  });

  it("reflects an Availability flip on the next call", () => {
    const provider = fakeProvider("fixture", {
      defaults: {},
      models: [MUSIC_ROW],
    });
    const manager = new ModelManager({ providers: [provider] });
    expect(manager.offers("generate-music")[0]?.available).toBe(true);

    provider.available = false;
    expect(manager.offers("generate-music")[0]?.available).toBe(false);
  });

  it("keeps a media row's price out of the token cost map", () => {
    const priced = fakeProvider("fixture", {
      defaults: {},
      models: [
        { ...MUSIC_ROW, price: { unit: "second", usd: 0.01 } },
        {
          costs: { input: 1, output: 2 },
          id: "smart",
          kind: "text",
          modelId: "upstream/smart",
        },
      ],
    });
    new ModelManager({ providers: [priced] });

    expect(configureModelObservability).toHaveBeenLastCalledWith({
      cost: { "upstream/smart": { input: 1, output: 2 } },
    });
  });
});
