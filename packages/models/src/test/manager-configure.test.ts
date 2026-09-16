import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeProvider } from "./helpers/model";

vi.mock("@browser-ai/transformers-js", () => ({
  transformersJS: {
    embeddingModel: vi.fn(() => ({ provider: "local" })),
    languageModel: vi.fn(() => ({ provider: "local" })),
    transcriptionModel: vi.fn(() => ({ provider: "local" })),
  },
}));
vi.mock("@huggingface/transformers", () => ({
  env: {},
  pipeline: vi.fn(),
}));

const { ModelManager } = await import("../manager");
const { LocalProvider } = await import("../local");
const { configureModelObservability } = await import("../logger");
const { falBinding, falProvider } = await import("../fal/provider");
const { setFalRuntime } = await import("../fal/client");
const { gatewayBinding } = await import("../gateway");
const { replicateBinding } = await import("../replicate");
const { vercelBinding, vercelProvider } = await import("../vercel");

/** The assembly a host ships: vercel registered up front, the rest bound to the credential record. */
function seeded() {
  const manager = new ModelManager({
    bindings: [vercelBinding, gatewayBinding, falBinding, replicateBinding],
    providers: [vercelProvider()],
  });
  manager.bootstrap();
  return manager;
}

describe("ModelManager.bootstrap", () => {
  it("registers nothing on its own; providers and the on-device runtime are the host's to add", () => {
    const manager = new ModelManager();
    manager.bootstrap();
    expect(manager.list()).toEqual([]);
    expect(manager.local).toBeNull();
    expect(manager.getDefault("embedding")).toBeNull();
  });

  it("registers a bound provider from credentials, even one never registered up front", () => {
    const manager = new ModelManager({ bindings: [vercelBinding] });
    manager.bootstrap({ credentials: { vercelApiKey: "vk" } });
    expect(manager.get("vercel").available).toBe(true);
  });

  it("routes embeddings on-device once a host has registered local", () => {
    const local = new LocalProvider();
    const manager = new ModelManager({ providers: [local] });
    manager.bootstrap();
    expect(manager.get("local")).toBe(local);
    expect(manager.embedding().provider).toBe("local");
  });
});

describe("ModelManager.configure — gateway lifecycle", () => {
  it("registers the gateway provider when aiGatewayUrl is set", () => {
    const manager = seeded();
    expect(manager.has("gateway")).toBe(false);
    manager.configure({ aiGatewayApiKey: "k", aiGatewayUrl: "http://gw" });
    expect(manager.has("gateway")).toBe(true);
    expect(manager.get("gateway").available).toBe(true);
  });

  it("reconfigures the existing gateway instead of re-registering", () => {
    const manager = seeded();
    manager.configure({ aiGatewayApiKey: "k", aiGatewayUrl: "http://gw" });
    const first = manager.get("gateway");
    manager.configure({ aiGatewayApiKey: "k2", aiGatewayUrl: "http://gw2" });
    expect(manager.get("gateway")).toBe(first);
  });

  it("refreshes an existing gateway's bundled catalog on reconfigure", () => {
    const manager = seeded();
    manager.configure({ aiGatewayApiKey: "k", aiGatewayUrl: "http://gw" });
    manager.configure({
      aiGatewayApiKey: "k",
      aiGatewayUrl: "http://gw",
      gatewayModels: [{ id: "x", kind: "text", modelId: "x" }],
    });
    expect(manager.get("gateway").models.map((m) => m.id)).toEqual(["x"]);
  });

  it("unregisters the gateway when aiGatewayUrl is cleared", () => {
    const manager = seeded();
    manager.configure({ aiGatewayApiKey: "k", aiGatewayUrl: "http://gw" });
    manager.configure({ aiGatewayUrl: null });
    expect(manager.has("gateway")).toBe(false);
  });
});

describe("ModelManager.configure — vercel re-key", () => {
  it("suppresses the vercel key when a gateway URL is present (gateway owns the key)", () => {
    const manager = seeded();
    manager.configure({ aiGatewayApiKey: "k", aiGatewayUrl: "http://gw" });
    expect(manager.get("vercel").available).toBe(false);
  });

  it("keys vercel from the gateway key when no gateway URL is given", () => {
    const manager = seeded();
    manager.configure({ aiGatewayApiKey: "k" });
    expect(manager.get("vercel").available).toBe(true);
  });

  it("keys vercel from a first-class vercelApiKey, even with a gateway URL", () => {
    const manager = seeded();
    manager.configure({
      aiGatewayApiKey: "k",
      aiGatewayUrl: "http://gw",
      vercelApiKey: "vk",
    });
    expect(manager.get("vercel").available).toBe(true);
  });
});

/** A Provider that bears a generate-image fact, for the substitution path. */
function imageBearer(id: string) {
  return fakeProvider(id, {
    defaults: {},
    models: [
      {
        id: `${id}/img`,
        kind: "image",
        modelId: `${id}/img`,
        operations: [
          {
            delivery: "whole",
            inputs: ["direction"],
            mode: "request",
            operation: "generate-image",
            outputs: ["image/png"],
            required: ["direction"],
          },
        ],
      },
    ],
  });
}

describe("ModelManager.configure — fal and replicate lifecycle", () => {
  afterEach(() => {
    setFalRuntime(null);
  });

  it("registers fal on falApiKey and offers its rows as available", () => {
    const manager = seeded();
    expect(manager.has("fal")).toBe(false);
    manager.configure({ falApiKey: "fal_key" });
    expect(manager.has("fal")).toBe(true);
    const falOffers = manager
      .offers("generate-image")
      .filter((offer) => offer.provider === "fal");
    expect(falOffers.length).toBeGreaterThan(0);
    expect(falOffers.every((offer) => offer.available)).toBe(true);
  });

  it("registers replicate on replicateApiToken", () => {
    const manager = seeded();
    manager.configure({ replicateApiToken: "r8_token" });
    expect(manager.get("replicate").available).toBe(true);
  });

  it("reconfigures the existing fal rather than re-registering it", () => {
    const manager = seeded();
    manager.configure({ falApiKey: "fal_one" });
    const first = manager.get("fal");
    manager.configure({ falApiKey: "fal_two" });
    expect(manager.get("fal")).toBe(first);
    expect(first.available).toBe(true);
  });

  it("is idempotent across add, remove, and add again", () => {
    const manager = seeded();
    manager.configure({ falApiKey: "fal_key" });
    manager.configure({ falApiKey: null });
    expect(manager.has("fal")).toBe(false);
    manager.configure({ falApiKey: "fal_key" });
    expect(manager.has("fal")).toBe(true);
    expect(manager.get("fal").available).toBe(true);
    expect(
      manager.offers("segment-image").map((offer) => offer.provider)
    ).toEqual(["fal"]);
  });

  it("unregisters fal on a null key and drops it from offers entirely", () => {
    const manager = seeded();
    manager.configure({ falApiKey: "fal_key" });
    manager.configure({ falApiKey: null });
    expect(manager.has("fal")).toBe(false);
    expect(manager.offers("segment-image")).toEqual([]);
  });

  it("refuses both resolution paths after removal, with no other bearing Provider", () => {
    const manager = seeded();
    manager.configure({ falApiKey: "fal_key" });
    manager.configure({ falApiKey: null });
    // The fixture catalog decides which refusal the defaulted path gives, so
    // state it: nothing else registered bears a generate-image fact.
    expect(manager.offers("generate-image")).toEqual([]);
    expect(() => manager.select("generate-image", { provider: "fal" })).toThrow(
      /Provider "fal" is not registered/
    );
    expect(() => manager.select("generate-image")).toThrow(
      /No credentialed provider/
    );
  });

  it("substitutes the other registered Provider on the defaulted path", () => {
    const manager = seeded();
    manager.register(imageBearer("other"));
    manager.configure({ falApiKey: "fal_key" });
    manager.configure({ falApiKey: null });
    expect(() => manager.select("generate-image", { provider: "fal" })).toThrow(
      /Provider "fal" is not registered/
    );
    const selection = manager.select("generate-image");
    expect(selection.provider.id).toBe("other");
    expect(selection.model.id).toBe("other/img");
  });

  it("keeps a registered but unavailable Provider in offers and refuses when named", () => {
    const manager = new ModelManager();
    manager.register(falProvider());
    expect(
      manager.offers("segment-image").map((offer) => offer.available)
    ).toEqual([false]);
    expect(() => manager.select("segment-image", { provider: "fal" })).toThrow(
      /No credentialed provider/
    );
  });

  it("audits PROVIDER_CONFIGURE for fal and replicate", () => {
    const audits: { action?: string; target?: { id?: string } }[] = [];
    configureModelObservability({
      enabled: true,
      logger: {
        drain: (ctx) => {
          const event = ctx.event as {
            audit?: { action?: string; target?: { id?: string } };
          };
          if (event.audit) {
            audits.push(event.audit);
          }
        },
      },
    });
    const manager = seeded();
    manager.configure({ falApiKey: "fal_key", replicateApiToken: "r8_token" });
    expect(
      audits
        .filter((audit) => audit.action === "models.PROVIDER_CONFIGURE")
        .map((audit) => audit.target?.id)
    ).toEqual(expect.arrayContaining(["fal", "replicate"]));
  });

  it("audits nothing for a key that was absent and stays absent", () => {
    const audits: string[] = [];
    configureModelObservability({
      enabled: true,
      logger: {
        drain: (ctx) => {
          const event = ctx.event as { audit?: { target?: { id?: string } } };
          if (event.audit?.target?.id) {
            audits.push(event.audit.target.id);
          }
        },
      },
    });
    const manager = seeded();
    manager.configure({ vercelApiKey: "vk" });
    expect(audits).not.toContain("fal");
    expect(audits).not.toContain("replicate");
  });

  it("carries a media price through offers and never onto a row's costs", () => {
    const manager = new ModelManager();
    manager.register(
      falProvider({
        config: { apiKey: "fal_key" },
        models: [
          {
            id: "vendor/priced",
            kind: "music",
            modelId: "vendor/priced",
            operations: [
              {
                delivery: "whole",
                inputs: ["direction"],
                mode: "request",
                operation: "generate-music",
                outputs: ["audio/mpeg"],
                required: ["direction"],
              },
            ],
            price: { unit: "second", usd: 0.002 },
          },
        ],
      })
    );
    const [offer] = manager.offers("generate-music");
    expect(offer?.model.price).toEqual({ unit: "second", usd: 0.002 });
    expect(offer?.model.costs).toBeUndefined();
  });
});
