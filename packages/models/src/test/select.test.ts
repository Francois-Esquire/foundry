import { describe, expect, it } from "vitest";

import type { LocalProviderSurface } from "../local/surface";
import { ModelManager } from "../manager";
import type {
  CapabilityFact,
  OperationName,
  ProviderModelDefinition,
} from "../types";
import { fakeProvider } from "./helpers/model";

const PROVIDER_FIXTURE_DOES_NOT_SUPPORT_THE_GENERATE_PATTERN =
  /^Provider "fixture" does not support the generate-text Operation in request mode\.$/;
const PROVIDER_NOPE_IS_NOT_REGISTERED_PATTERN =
  /Provider "nope" is not registered/;
const MODEL_UNKNOWN_ID_IS_NOT_REGISTERED_PATTERN =
  /Model "unknown-id" is not registered/;
const PROVIDER_FIXTURE_DOES_NOT_SUPPORT_THE_GENERATE_PATTERN_2 =
  /^Provider "fixture" does not support the generate-image Operation in request mode\.$/;
const NO_CREDENTIALED_PROVIDER_CAN_SERVE_GENERATE_IMAGE_PATTERN =
  /No credentialed provider can serve "generate-image"/;
const NO_CREDENTIALED_PROVIDER_CAN_SERVE_GENERATE_IMAGE_PATTERN_2 =
  /No credentialed provider can serve "generate-image"/;
const AIRPLANE_MODE_IS_ENABLED_PATTERN = /Airplane Mode is enabled/;
const AIRPLANE_MODE_IS_ENABLED_AND_THE_LOCAL_PATTERN =
  /Airplane Mode is enabled and the local provider cannot serve "generate-image"/;
const DOES_NOT_SUPPORT_VIDEO_MODELS_PATTERN = /does not support video models/;
const MODEL_MISSING_IS_NOT_REGISTERED_PATTERN =
  /Model "missing" is not registered/;
const PROVIDER_NOPE_IS_NOT_REGISTERED_PATTERN_2 =
  /Provider "nope" is not registered/;
const DOES_NOT_SUPPORT_MEDIA_MODELS_PATTERN = /does not support media models/;
const PROVIDER_FIXTURE_DOES_NOT_SUPPORT_THE_GENERATE_PATTERN_3 =
  /^Provider "fixture" does not support the generate-video Operation in live mode\.$/;
const PROVIDER_FIXTURE_DOES_NOT_SUPPORT_THE_GENERATE_PATTERN_4 =
  /^Provider "fixture" does not support the generate-image Operation in request mode\.$/;

/** A Request-mode fact, so a row can be written in one line. */
function fact(
  operation: OperationName,
  outputs: string[],
  overrides: Partial<CapabilityFact> = {}
): CapabilityFact {
  return {
    delivery: "whole",
    inputs: ["direction"],
    mode: "request",
    operation,
    outputs,
    required: ["direction"],
    ...overrides,
  };
}

const OPERATION_ROWS: { operation: OperationName; mime: string }[] = [
  { mime: "text/markdown", operation: "generate-text" },
  { mime: "text/markdown", operation: "reformat-text" },
  { mime: "image/png", operation: "generate-image" },
  { mime: "video/mp4", operation: "generate-video" },
  { mime: "audio/mpeg", operation: "generate-speech" },
  { mime: "audio/mpeg", operation: "generate-music" },
  { mime: "audio/mpeg", operation: "generate-sound-effect" },
  { mime: "text/plain", operation: "transcribe" },
  {
    mime: "application/vnd.foundry.segmentation+json",
    operation: "segment-image",
  },
  {
    mime: "application/vnd.foundry.segmentation+json",
    operation: "segment-video",
  },
];

/** One row per Operation, each admitted only by its explicit fact. */
const EVERY_OPERATION: ProviderModelDefinition[] = OPERATION_ROWS.map(
  ({ operation, mime }) => ({
    id: operation,
    kind: "image",
    modelId: `upstream/${operation}`,
    operations: [fact(operation, [mime])],
  })
);

const FIRST_IMAGE: ProviderModelDefinition = {
  id: "first-img",
  kind: "image",
  modelId: "upstream/first",
  operations: [fact("generate-image", ["image/png"])],
};

/** Two rows bearing generate-image, so a default can name the second one. */
const IMAGE_PAIR: ProviderModelDefinition[] = [
  FIRST_IMAGE,
  {
    id: "second-img",
    kind: "image",
    modelId: "upstream/second",
    operations: [fact("generate-image", ["image/png"])],
  },
];

function withCatalog(models: ProviderModelDefinition[]) {
  const provider = fakeProvider("fixture", { defaults: {}, models });
  return { manager: new ModelManager({ providers: [provider] }), provider };
}

/** A provider the manager accepts as the local role, for Airplane Mode. */
function fakeLocal(models: ProviderModelDefinition[]) {
  const provider = fakeProvider("local", {
    defaults: {},
    models,
    offline: true,
  });
  return Object.assign(provider, {
    download: () => Promise.resolve(),
    downloadedModels: () => [],
    isDownloaded: () => true,
    preload: () => Promise.resolve(),
    progress: () => undefined,
    status: () => undefined,
    transcribe: () => Promise.resolve({ text: "" }),
  }) as unknown as LocalProviderSurface & typeof provider;
}

describe("select by Capability fact", () => {
  it("returns the matching fact for each of the ten Operations", () => {
    const { manager } = withCatalog(EVERY_OPERATION);
    for (const { operation, mime } of OPERATION_ROWS) {
      const selection = manager.select(operation, {
        model: operation,
        provider: "fixture",
      });
      expect(selection.provider.id).toBe("fixture");
      expect(selection.model.id).toBe(operation);
      expect(selection.fact.operation).toBe(operation);
      expect(selection.fact.mode).toBe("request");
      expect(selection.fact.outputs[0]).toBe(mime);
    }
  });

  it("carries Unknown price through as absence", () => {
    const { manager } = withCatalog(EVERY_OPERATION);
    expect(
      manager.select("generate-image", {
        model: "generate-image",
        provider: "fixture",
      }).model.price
    ).toBeUndefined();
  });

  it("refuses a Model without the fact instead of falling back to one with it", () => {
    const { manager } = withCatalog([
      {
        id: "img-1",
        kind: "image",
        modelId: "upstream/img",
        operations: [fact("generate-image", ["image/png"])],
      },
      { id: "embed", kind: "embedding", modelId: "upstream/embed" },
    ]);
    expect(() =>
      manager.select("generate-image", { model: "embed", provider: "fixture" })
    ).toThrow(PROVIDER_FIXTURE_DOES_NOT_SUPPORT_THE_GENERATE_PATTERN_4);
  });

  it("refuses live mode on a request-only row", () => {
    const { manager } = withCatalog(EVERY_OPERATION);
    expect(() =>
      manager.select("generate-video", {
        mode: "live",
        model: "generate-video",
        provider: "fixture",
      })
    ).toThrow(PROVIDER_FIXTURE_DOES_NOT_SUPPORT_THE_GENERATE_PATTERN_3);
  });

  it("admits a live fact when the row declares one", () => {
    const { manager } = withCatalog([
      {
        id: "lucy",
        kind: "video",
        modelId: "upstream/lucy",
        operations: [
          fact("generate-video", ["video/mp4"]),
          fact("generate-video", ["video/mp4"], {
            delivery: "continuous",
            inputs: ["direction", "feed"],
            mode: "live",
          }),
        ],
      },
    ]);
    const live = manager.select("generate-video", {
      mode: "live",
      model: "lucy",
      provider: "fixture",
    });
    expect(live.fact.delivery).toBe("continuous");
    expect(live.fact.inputs).toContain("feed");
  });

  it("refuses an unknown Provider", () => {
    const { manager } = withCatalog(EVERY_OPERATION);
    expect(() =>
      manager.select("generate-image", { provider: "nope" })
    ).toThrow(PROVIDER_NOPE_IS_NOT_REGISTERED_PATTERN);
  });

  it("refuses an unknown Model id where a kind accessor still passes it through", () => {
    const { provider, manager } = withCatalog(EVERY_OPERATION);
    expect(() =>
      manager.select("generate-image", {
        model: "unknown-id",
        provider: "fixture",
      })
    ).toThrow(MODEL_UNKNOWN_ID_IS_NOT_REGISTERED_PATTERN);

    manager.image("unknown-id", "fixture");
    expect(provider.calls).toContain("image:unknown-id");
  });

  it("derives legacy text facts and refuses what Kind does not derive", () => {
    const { manager } = withCatalog([
      { id: "smart", kind: "text", modelId: "upstream/smart" },
    ]);
    expect(
      manager.select("generate-text", { provider: "fixture" }).model.id
    ).toBe("smart");
    expect(
      manager.select("reformat-text", { provider: "fixture" }).model.id
    ).toBe("smart");
    expect(() =>
      manager.select("generate-image", { provider: "fixture" })
    ).toThrow(PROVIDER_FIXTURE_DOES_NOT_SUPPORT_THE_GENERATE_PATTERN_2);
  });

  it("offers nothing for an embedding row", () => {
    const { manager } = withCatalog([
      { id: "embed", kind: "embedding", modelId: "upstream/embed" },
    ]);
    expect(() =>
      manager.select("generate-text", { provider: "fixture" })
    ).toThrow(PROVIDER_FIXTURE_DOES_NOT_SUPPORT_THE_GENERATE_PATTERN);
  });

  it("returns equal Selections for two identical calls", () => {
    const { manager } = withCatalog([
      { id: "smart", kind: "text", modelId: "upstream/smart" },
    ]);
    const first = manager.select("generate-text", { provider: "fixture" });
    const second = manager.select("generate-text", { provider: "fixture" });
    expect(first).toEqual(second);
  });
});

describe("select model defaults", () => {
  it("honours the configured Kind default model when it bears the fact", () => {
    const provider = fakeProvider("fixture", {
      defaults: {},
      models: IMAGE_PAIR,
    });
    const manager = new ModelManager({
      defaults: { image: { modelId: "second-img", provider: "fixture" } },
      providers: [provider],
    });
    expect(manager.select("generate-image").model.id).toBe("second-img");
  });

  it("honours the Provider's own default model when it bears the fact", () => {
    const provider = fakeProvider("fixture", {
      defaults: { image: "second-img" },
      models: IMAGE_PAIR,
    });
    const manager = new ModelManager({ providers: [provider] });
    expect(manager.select("generate-image").model.id).toBe("second-img");
  });

  it("falls through to the first bearing row when the default bears no fact", () => {
    const provider = fakeProvider("fixture", {
      defaults: { image: "seg-only" },
      models: [
        {
          id: "seg-only",
          kind: "image",
          modelId: "upstream/seg",
          operations: [
            fact("segment-image", [
              "application/vnd.foundry.segmentation+json",
            ]),
          ],
        },
        FIRST_IMAGE,
      ],
    });
    const manager = new ModelManager({
      defaults: { image: { modelId: "seg-only", provider: "fixture" } },
      providers: [provider],
    });
    expect(manager.select("generate-image").model.id).toBe("first-img");
  });

  it("skips the manager Kind default when the caller names the Provider", () => {
    const provider = fakeProvider("fixture", {
      defaults: {},
      models: IMAGE_PAIR,
    });
    const manager = new ModelManager({
      defaults: { image: { modelId: "second-img", provider: "fixture" } },
      providers: [provider],
    });
    expect(
      manager.select("generate-image", { provider: "fixture" }).model.id
    ).toBe("first-img");
  });

  it("skips the manager Kind default under Airplane Mode", () => {
    const local = fakeLocal(IMAGE_PAIR);
    const manager = new ModelManager({
      defaults: { image: { modelId: "second-img", provider: "local" } },
      providers: [local],
    });
    manager.setOfflineMode(true);
    expect(manager.select("generate-image").model.id).toBe("first-img");
  });
});

describe("select provider resolution", () => {
  it("refuses when no provider is named and none is available", () => {
    const provider = fakeProvider("fixture", {
      available: false,
      defaults: {},
      models: EVERY_OPERATION,
    });
    const manager = new ModelManager({ providers: [provider] });
    expect(() => manager.select("generate-image")).toThrow(
      NO_CREDENTIALED_PROVIDER_CAN_SERVE_GENERATE_IMAGE_PATTERN
    );
  });

  it("refuses when the named provider is registered but unavailable", () => {
    const provider = fakeProvider("fixture", {
      available: false,
      defaults: {},
      models: EVERY_OPERATION,
    });
    const manager = new ModelManager({ providers: [provider] });
    expect(() =>
      manager.select("generate-image", {
        model: "generate-image",
        provider: "fixture",
      })
    ).toThrow(NO_CREDENTIALED_PROVIDER_CAN_SERVE_GENERATE_IMAGE_PATTERN_2);
  });

  it("skips providers whose rows lack the fact when none is named", () => {
    const bare = fakeProvider("bare", {
      defaults: {},
      models: [{ id: "embed", kind: "embedding", modelId: "upstream/embed" }],
    });
    const serving = fakeProvider("serving", {
      defaults: {},
      models: EVERY_OPERATION,
    });
    const manager = new ModelManager({ providers: [bare, serving] });
    expect(manager.select("generate-image").provider.id).toBe("serving");
  });

  it("prefers the kind default among providers that already bear the fact", () => {
    const first = fakeProvider("first", {
      defaults: {},
      models: EVERY_OPERATION,
    });
    const second = fakeProvider("second", {
      defaults: {},
      models: EVERY_OPERATION,
    });
    const manager = new ModelManager({
      defaults: { image: { provider: "second" } },
      providers: [first, second],
    });
    expect(manager.select("generate-image").provider.id).toBe("second");
  });

  it("does not admit the kind default when its rows bear no matching fact", () => {
    const bare = fakeProvider("bare", {
      defaults: {},
      models: [{ id: "img", kind: "image", modelId: "upstream/img" }],
    });
    const serving = fakeProvider("serving", {
      defaults: {},
      models: EVERY_OPERATION,
    });
    const manager = new ModelManager({
      defaults: { image: { provider: "bare" } },
      providers: [bare, serving],
    });
    expect(manager.select("segment-image").provider.id).toBe("serving");
  });

  it("routes only to the local role under Airplane Mode", () => {
    const cloud = fakeProvider("cloud", {
      defaults: {},
      models: EVERY_OPERATION,
    });
    const local = fakeLocal([
      {
        id: "on-device",
        kind: "image",
        modelId: "device/img",
        operations: [fact("generate-image", ["image/png"])],
      },
    ]);
    const manager = new ModelManager({ providers: [cloud, local] });
    manager.setOfflineMode(true);

    expect(manager.select("generate-image").provider.id).toBe("local");
    expect(() =>
      manager.select("generate-image", { provider: "cloud" })
    ).toThrow(AIRPLANE_MODE_IS_ENABLED_PATTERN);
  });

  it("refuses as Airplane Mode, not as missing credentials, when the local role is unavailable", () => {
    const local = fakeLocal([
      {
        id: "on-device",
        kind: "image",
        modelId: "device/img",
        operations: [fact("generate-image", ["image/png"])],
      },
    ]);
    local.available = false;
    const manager = new ModelManager({ providers: [local] });
    manager.setOfflineMode(true);

    expect(() => manager.select("generate-image")).toThrow(
      AIRPLANE_MODE_IS_ENABLED_AND_THE_LOCAL_PATTERN
    );
  });
});

describe("video and media accessors", () => {
  it("refuses video on a provider that declares no videoModel", () => {
    const provider = fakeProvider("fixture", {
      defaults: {},
      kinds: [],
      models: [{ id: "vid", kind: "video", modelId: "upstream/vid" }],
    });
    const manager = new ModelManager({ providers: [provider] });
    expect(() => manager.video("vid", "fixture")).toThrow(
      DOES_NOT_SUPPORT_VIDEO_MODELS_PATTERN
    );
  });

  it("builds a video model on the wire id when the provider declares one", () => {
    const provider = fakeProvider("fixture", {
      defaults: {},
      kinds: ["video"],
      models: [{ id: "vid", kind: "video", modelId: "upstream/vid" }],
    });
    const manager = new ModelManager({ providers: [provider] });
    manager.video("vid", "fixture");
    expect(provider.calls).toContain("video:upstream/vid");
  });

  it("refuses a media id the provider does not carry rather than defaulting", () => {
    const provider = fakeProvider("fixture", {
      defaults: {},
      kinds: ["media"],
      models: [{ id: "sam", kind: "segmentation", modelId: "upstream/sam" }],
    });
    const manager = new ModelManager({ providers: [provider] });
    expect(() => manager.media("missing", "fixture")).toThrow(
      MODEL_MISSING_IS_NOT_REGISTERED_PATTERN
    );
    expect(() => manager.media("sam", "nope")).toThrow(
      PROVIDER_NOPE_IS_NOT_REGISTERED_PATTERN_2
    );
  });

  it("runs a media model and returns output of the requested operation", async () => {
    const provider = fakeProvider("fixture", {
      defaults: {},
      kinds: ["media"],
      models: [
        {
          id: "music",
          kind: "music",
          modelId: "upstream/music",
          operations: [fact("generate-music", ["audio/mpeg"])],
        },
      ],
    });
    const manager = new ModelManager({ providers: [provider] });
    const selection = manager.select("generate-music", {
      model: "music",
      provider: "fixture",
    });
    const output = await manager
      .media(selection.model.id, selection.provider.id)
      .run({ direction: "a march", operation: "generate-music" });

    expect(output).toMatchObject({
      audio: { mime: selection.fact.outputs[0] },
      operation: "generate-music",
    });
    expect(provider.calls).toContain("media:upstream/music:generate-music");
  });

  it("refuses media on a provider that declares no mediaModel", () => {
    const provider = fakeProvider("fixture", {
      defaults: {},
      kinds: [],
      models: [{ id: "sam", kind: "segmentation", modelId: "upstream/sam" }],
    });
    const manager = new ModelManager({ providers: [provider] });
    expect(() => manager.media("sam", "fixture")).toThrow(
      DOES_NOT_SUPPORT_MEDIA_MODELS_PATTERN
    );
  });

  it("grants live access without exposing a key", async () => {
    const provider = fakeProvider("fixture", { kinds: ["grant"] });
    const access = await provider.grant?.(
      "upstream/realtime",
      "generate-image"
    );
    expect(access).toMatchObject({ kind: "token", token: "fake" });
    const expiresAt = access?.kind === "token" ? access.expiresAt : undefined;
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(access)).not.toContain("apiKey");
  });
});
