import type { LanguageModelV4 } from "@ai-sdk/provider";

import { describe, expect, it } from "vitest";

import { ModelManager } from "../manager";
import { fakeProvider } from "./helpers/model";

describe("ModelManager registry", () => {
  it("registers providers and looks them up by id", () => {
    const manager = new ModelManager();
    const a = fakeProvider("a");
    manager.register(a);
    expect(manager.has("a")).toBe(true);
    expect(manager.get("a")).toBe(a);
    expect(manager.list()).toEqual([a]);
  });

  it("get throws on a missing id", () => {
    const manager = new ModelManager();
    expect(() => manager.get("nope")).toThrow(/not registered/);
  });

  it("unregister removes the provider", () => {
    const manager = new ModelManager({ providers: [fakeProvider("a")] });
    manager.unregister("a");
    expect(manager.has("a")).toBe(false);
  });

  it("setDefault rejects an unregistered provider", () => {
    const manager = new ModelManager();
    expect(() => {
      manager.setDefault("text", { provider: "x" });
    }).toThrow(/not registered/);
  });
});

describe("ModelManager kind dispatch", () => {
  it("routes each kind to the provider with the resolved wire id", () => {
    const p = fakeProvider("p", {
      models: [
        { id: "smart", kind: "text", modelId: "upstream/smart" },
        { id: "embed", kind: "embedding", modelId: "upstream/embed" },
        { id: "img", kind: "image", modelId: "upstream/img" },
        { id: "say", kind: "speech", modelId: "upstream/say" },
        { id: "ear", kind: "transcription", modelId: "upstream/ear" },
      ],
    });
    const manager = new ModelManager({ providers: [p] });

    manager.model();
    manager.embedding();
    manager.image();
    manager.speech();
    manager.transcription();

    expect(p.calls).toEqual([
      "text:upstream/smart",
      "embedding:upstream/embed",
      "image:upstream/img",
      "speech:upstream/say",
      "transcription:upstream/ear",
    ]);
  });

  it("an explicit provider id wins over the kind default", () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const manager = new ModelManager({
      defaults: { text: { provider: "a" } },
      providers: [a, b],
    });
    manager.model("smart", "b");
    expect(b.calls).toEqual(["text:upstream/smart"]);
    expect(a.calls).toEqual([]);
  });

  it("a kind default may carry a model id, used when the caller names none", () => {
    const a = fakeProvider("a", {
      models: [
        { id: "smart", kind: "text", modelId: "upstream/smart" },
        { id: "fast", kind: "text", modelId: "upstream/fast" },
      ],
    });
    const manager = new ModelManager({
      defaults: { text: { modelId: "fast", provider: "a" } },
      providers: [a],
    });
    manager.model();
    manager.model("smart");
    expect(a.calls).toEqual(["text:upstream/fast", "text:upstream/smart"]);
  });

  it("unknown ids pass through as the wire id", () => {
    const a = fakeProvider("a");
    const manager = new ModelManager({ providers: [a] });
    manager.model("brand/new");
    expect(a.calls).toEqual(["text:brand/new"]);
  });

  it("rejects a known id of the wrong kind", () => {
    const manager = new ModelManager({ providers: [fakeProvider("a")] });
    expect(() => manager.model("embed")).toThrow(/is kind "embedding"/);
  });

  it("throws CAPABILITY_UNSUPPORTED when the provider lacks the kind", () => {
    const manager = new ModelManager({
      providers: [fakeProvider("a", { kinds: [] })],
    });
    expect(() => manager.embedding(undefined, "a")).toThrow(
      /does not support embedding/
    );
  });

  it("throws when no provider can serve the kind", () => {
    const manager = new ModelManager();
    expect(() => manager.model()).toThrow(/No credentialed provider/);
  });

  it("throws when an explicit provider id is not registered", () => {
    const manager = new ModelManager({ providers: [fakeProvider("a")] });
    expect(() => manager.model("smart", "ghost")).toThrow(/not registered/);
  });

  it("returns a model that declares its route and window, delegating calls to the provider's", () => {
    const provider = fakeProvider("vercel", {
      harness: "studio",
      models: [
        {
          id: "smart",
          kind: "text",
          limits: { maxInputTokens: 200_000, maxOutputTokens: 8192 },
          modelId: "upstream/smart",
        },
      ],
    });
    const manager = new ModelManager({ providers: [provider] });

    const model = manager.model("smart", "vercel");

    expect(model.modelId).toBe("upstream/smart");
    expect(model.route).toEqual({
      harness: "studio",
      id: "smart",
      provider: "vercel",
    });
    expect(model.limits).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    });
    expect(provider.calls).toEqual(["text:upstream/smart"]);
  });

  it("omits limits when the catalog row declares none", () => {
    const manager = new ModelManager({ providers: [fakeProvider("vercel")] });
    expect(manager.model("smart", "vercel")).not.toHaveProperty("limits");
  });

  it("forwards the working directory to the provider", () => {
    const seen: (string | undefined)[] = [];
    const provider = fakeProvider("cli");
    provider.languageModel = (modelId, options) => {
      seen.push(options?.workingDirectory);
      return { modelId, provider: "cli" } as LanguageModelV4;
    };
    const manager = new ModelManager({ providers: [provider] });
    manager.model("smart", "cli", { workingDirectory: "/repo" });
    expect(seen).toEqual(["/repo"]);
  });
});

describe("ModelManager.textLimits / embeddingDimensions", () => {
  it("maps a declared text model's limits to a window shape", () => {
    const manager = new ModelManager({
      providers: [
        fakeProvider("p", {
          defaults: {},
          models: [
            {
              id: "big",
              kind: "text",
              limits: { maxInputTokens: 200_000, maxOutputTokens: 8192 },
              modelId: "upstream/big",
            },
          ],
        }),
      ],
    });
    expect(manager.textLimits("big", "p")).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    });
    // Catalog id resolution — the same path `model()` takes.
    expect(manager.textLimits(undefined, "p")).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    });
  });

  it("returns undefined when the model declares no limits or nothing resolves", () => {
    const manager = new ModelManager({ providers: [fakeProvider("p")] });
    expect(manager.textLimits("smart", "p")).toBeUndefined();
    expect(manager.textLimits("x", "ghost")).toBeUndefined();
  });

  it("reads embedding dimensions off the resolved row", () => {
    const manager = new ModelManager({
      providers: [
        fakeProvider("p", {
          defaults: {},
          models: [
            {
              dimensions: 384,
              id: "e",
              kind: "embedding",
              modelId: "upstream/e",
            },
          ],
        }),
      ],
    });
    expect(manager.embeddingDimensions(undefined, "p")).toBe(384);
  });
});

describe("ModelManager settings reactivity", () => {
  it("re-applies kind-defaults when settings.defaults changes, and routing follows", () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const manager = new ModelManager({ providers: [a, b] });

    manager.model();
    expect(a.calls).toHaveLength(1);

    manager.settings.set("defaults", { text: { provider: "b" } });
    manager.model();
    expect(b.calls).toHaveLength(1);
  });

  it("skips a settings default that names an unregistered provider — no throw", () => {
    const manager = new ModelManager({ providers: [fakeProvider("a")] });
    expect(() => {
      manager.settings.set("defaults", { text: { provider: "ghost" } });
    }).not.toThrow();
    expect(() => manager.model()).not.toThrow();
  });
});

describe("ModelManager.defaultProviderFor", () => {
  it("returns the first available online provider serving the kind", () => {
    const manager = new ModelManager({
      providers: [
        fakeProvider("off", { available: false }),
        fakeProvider("on"),
      ],
    });
    expect(manager.defaultProviderFor("text")).toBe("on");
  });

  it("skips offline + unavailable providers, returning null when none usable", () => {
    const manager = new ModelManager({
      providers: [
        fakeProvider("local", { offline: true }),
        fakeProvider("dead", { available: false }),
      ],
    });
    expect(manager.defaultProviderFor("text")).toBeNull();
  });

  it("prefers a usable configured kind-default over registration order", () => {
    const manager = new ModelManager({
      defaults: { text: { provider: "b" } },
      providers: [fakeProvider("a"), fakeProvider("b")],
    });
    expect(manager.defaultProviderFor("text")).toBe("b");
  });

  it("falls past an unusable kind-default to the next usable provider", () => {
    const manager = new ModelManager({
      defaults: { text: { provider: "b" } },
      providers: [fakeProvider("a"), fakeProvider("b", { available: false })],
    });
    expect(manager.defaultProviderFor("text")).toBe("a");
  });

  it("does not route a kind to a provider that only serves other kinds", () => {
    const manager = new ModelManager({
      providers: [
        fakeProvider("embed-only", {
          models: [{ id: "e", kind: "embedding", modelId: "u/e" }],
        }),
      ],
    });
    expect(manager.defaultProviderFor("text")).toBeNull();
  });
});

describe("ModelManager.resolveTextExecutor", () => {
  it("returns one canonical harness/provider/model route", () => {
    const manager = new ModelManager({
      providers: [fakeProvider("codex", { harness: "codex" })],
    });
    expect(manager.resolveTextExecutor("smart", "codex")).toEqual({
      harness: "codex",
      model: "smart",
      provider: "codex",
    });
  });

  it("rejects a harness that does not own the selected provider", () => {
    const manager = new ModelManager({ providers: [fakeProvider("a")] });
    expect(() => manager.resolveTextExecutor("smart", "a", "codex")).toThrow(
      /does not own provider "a"/
    );
  });

  it("fails closed when an explicitly selected provider is unavailable", () => {
    const manager = new ModelManager({
      providers: [fakeProvider("a", { available: false })],
    });
    expect(() => manager.resolveTextExecutor("smart", "a")).toThrow(
      /No credentialed provider/
    );
  });
});

describe("ModelManager.dispose", () => {
  it("disposes every provider even when one fails", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    a.dispose = () => Promise.reject(new Error("boom"));
    const manager = new ModelManager({ providers: [a, b] });
    await manager.dispose();
    expect(b.disposed).toBe(1);
  });
});
