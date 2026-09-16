import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeProvider } from "./helpers/model";

const mockLanguageModel = vi.fn(() => ({ tag: "lm" }));
const mockEmbeddingModel = vi.fn(() => ({ tag: "em" }));
const mockTranscriptionModel = vi.fn(() => ({ tag: "tm" }));

vi.mock("@browser-ai/transformers-js", () => ({
  transformersJS: {
    embeddingModel: mockEmbeddingModel,
    languageModel: mockLanguageModel,
    transcriptionModel: mockTranscriptionModel,
  },
}));

const transformersEnv: { allowRemoteModels?: boolean } = {};
vi.mock("@huggingface/transformers", () => ({
  env: transformersEnv,
  pipeline: vi.fn(() => Promise.resolve(vi.fn())),
}));

const { ModelManager } = await import("../manager");
const { LocalProvider } = await import("../local");

/** decoy (offline, first) → cloud → the real local role. */
function airplane() {
  // The decoy merely claims `offline: true`; it is not the local role, so
  // Airplane Mode must never route to it. Registered first on purpose.
  const decoy = fakeProvider("decoy", { offline: true });
  const cloud = fakeProvider("cloud");
  const manager = new ModelManager({
    providers: [decoy, cloud, new LocalProvider()],
  });
  return { cloud, decoy, manager };
}

beforeEach(() => {
  LocalProvider.clearCache();
  mockLanguageModel.mockClear();
  mockEmbeddingModel.mockClear();
  mockTranscriptionModel.mockClear();
  delete transformersEnv.allowRemoteModels;
});

describe("Airplane Mode routing", () => {
  it("routes every served kind to the local role", () => {
    const { manager, decoy, cloud } = airplane();
    manager.setOfflineMode(true);

    manager.model();
    manager.embedding();
    manager.transcription();

    expect(mockLanguageModel).toHaveBeenCalledTimes(1);
    expect(mockEmbeddingModel).toHaveBeenCalledTimes(1);
    expect(mockTranscriptionModel).toHaveBeenCalledTimes(1);
    expect(decoy.calls).toEqual([]);
    expect(cloud.calls).toEqual([]);
    expect(manager.defaultProviderFor("text")).toBe("local");
  });

  it("rejects an explicit non-local provider before invoking it", () => {
    const { manager, cloud } = airplane();
    manager.setOfflineMode(true);
    expect(() => manager.model(undefined, "cloud")).toThrow(/Airplane Mode/);
    expect(cloud.calls).toEqual([]);
  });

  it("rejects a kind the local role does not serve", () => {
    const { manager } = airplane();
    manager.setOfflineMode(true);
    expect(() => manager.image()).toThrow(/no model of this kind/);
    expect(manager.defaultProviderFor("image")).toBeNull();
  });

  it("rejects every kind when no local role is registered", () => {
    const manager = new ModelManager({
      providers: [fakeProvider("decoy", { offline: true })],
    });
    manager.setOfflineMode(true);
    expect(() => manager.model()).toThrow(/no provider is registered/);
    expect(manager.defaultProviderFor("text")).toBeNull();
  });

  it("states the mode, the failure, no fallback, and the way out", () => {
    const { manager } = airplane();
    manager.setOfflineMode(true);
    const error = (() => {
      try {
        manager.image();
        return null;
      } catch (err) {
        return err as Error & { code: string; fix: string };
      }
    })();
    expect(error?.code).toBe("models.AIRPLANE_LOCAL_UNAVAILABLE");
    expect(error?.message).toContain("Airplane Mode is enabled");
    expect(error?.message).toContain('cannot serve "image"');
    expect(error?.message).toContain("No cloud fallback was attempted");
    expect(error?.fix).toMatch(/Local Models/);
  });

  it("tells providers to stop fetching remote weights", () => {
    const { manager, cloud } = airplane();
    manager.setOfflineMode(true);
    expect(transformersEnv.allowRemoteModels).toBe(false);
    expect(cloud.offlineCalls).toEqual([true]);

    manager.setOfflineMode(false);
    expect(transformersEnv.allowRemoteModels).toBe(true);
  });

  it("overrides stored defaults without mutating them, and restores on exit", () => {
    const { manager, cloud } = airplane();
    manager.setDefault("embedding", { provider: "cloud" });

    manager.setOfflineMode(true);
    manager.embedding();
    expect(mockEmbeddingModel).toHaveBeenCalledTimes(1);
    expect(cloud.calls).toEqual([]);

    manager.setOfflineMode(false);
    manager.embedding();
    expect(manager.offlineMode).toBe(false);
    expect(cloud.calls).toEqual(["embedding:upstream/embed"]);
    expect(mockEmbeddingModel).toHaveBeenCalledTimes(1);
  });
});

describe("local role identity", () => {
  it("does not treat a provider registered under a different id as local", () => {
    const manager = new ModelManager({
      providers: [new LocalProvider({ id: "other" })],
    });
    expect(manager.local).toBeNull();
  });

  it("does not treat a plain provider named local as the local surface", () => {
    const manager = new ModelManager({ providers: [fakeProvider("local")] });
    expect(manager.local).toBeNull();
    manager.setOfflineMode(true);
    expect(() => manager.model()).toThrow(/no provider is registered/);
  });
});
