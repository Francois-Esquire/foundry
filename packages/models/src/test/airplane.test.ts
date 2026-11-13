import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { airplaneMode } from "../airplane";
import { ModelManager } from "../manager";
import type { Provider } from "../provider";

const CALL = { prompt: [] } as unknown as LanguageModelV4CallOptions;
const REFUSED = /refused by airplane/;

interface Recorder extends Provider {
  offlineCalls: boolean[];
}

/**
 * A provider whose calls never settle and whose streams never end, ignoring
 * the abort signal, so only the manager's own guard can end them.
 */
function stubborn(id: string, offline = false): Recorder {
  const model: LanguageModelV4 = {
    doGenerate: () => new Promise(() => undefined),
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream({
          start: (controller) =>
            controller.enqueue({ delta: "hi", id: "1", type: "text-delta" }),
        }),
      }),
    modelId: "m",
    provider: id,
    specificationVersion: "v4",
    supportedUrls: {},
  };
  const provider: Recorder = {
    available: true,
    id,
    languageModel: () => model,
    models: [{ id: "m", kind: "text", modelId: "m" }],
    offline,
    offlineCalls: [],
    setOffline: (value) => {
      provider.offlineCalls.push(value);
    },
  };
  return provider;
}

describe("airplaneMode", () => {
  it("refuses network providers in its own manager only", () => {
    const here = new ModelManager({ providers: [stubborn("cloud")] });
    const there = new ModelManager({ providers: [stubborn("cloud")] });
    airplaneMode(here).set(true);
    expect(() => here.resolve("text", "cloud/m")).toThrow(REFUSED);
    expect(there.resolve("text", "cloud/m").provider).toBe("cloud");
  });

  it("skips refused providers for an unqualified selection", () => {
    const models = new ModelManager({
      providers: [stubborn("cloud"), stubborn("local", true)],
    });
    airplaneMode(models).set(true);
    expect(models.resolve("text", "m").provider).toBe("local");
    expect(models.resolve("text").provider).toBe("local");
  });

  it("refuses the next call on a model opened before, and every check and hold", async () => {
    const models = new ModelManager({ providers: [stubborn("cloud")] });
    const session = models.resolve("text", "cloud/m");
    const model = session.open();
    airplaneMode(models).set(true);
    await expect(model.doGenerate(CALL)).rejects.toThrow(REFUSED);
    expect(() => session.check()).toThrow(REFUSED);
    expect(() => models.resolve("text").hold()).toThrow();
  });

  it("aborts calls and streams in flight even when the provider ignores the signal", async () => {
    const models = new ModelManager({ providers: [stubborn("cloud")] });
    const model = models.resolve("text", "cloud/m").open();
    const pending = model.doGenerate(CALL);
    const { stream } = await model.doStream(CALL);
    const reader = stream.getReader();
    await reader.read();

    airplaneMode(models).set(true);

    await expect(pending).rejects.toThrow(REFUSED);
    await expect(reader.read()).rejects.toThrow(REFUSED);
  });

  it("tells every instance to go offline, including ones added later, and back online when lifted", () => {
    const first = stubborn("first");
    const later = stubborn("later");
    const models = new ModelManager({ providers: [first] });
    const airplane = airplaneMode(models);
    airplane.set(true);
    models.setProviders([first, later]);
    expect(first.offlineCalls).toEqual([true]);
    expect(later.offlineCalls).toEqual([true]);

    airplane.set(false);
    expect(first.offlineCalls).toEqual([true, false]);
    expect(models.resolve("text", "first/m").provider).toBe("first");
  });

  it("keeps refusing when an instance fails to go offline, and reports it", async () => {
    const throwing = stubborn("throwing");
    throwing.setOffline = () => {
      throw new Error("stuck");
    };
    const rejecting = stubborn("rejecting");
    rejecting.setOffline = () => Promise.reject(new Error("lost"));
    const after = stubborn("after");
    const models = new ModelManager({
      providers: [throwing, rejecting, after],
    });
    const failures: string[] = [];
    models.events.on("offline-failed", ({ provider }: { provider: string }) =>
      failures.push(provider)
    );
    airplaneMode(models).set(true);
    await vi.waitFor(() =>
      expect(failures.sort()).toEqual(["rejecting", "throwing"])
    );
    expect(after.offlineCalls).toEqual([true]);
    expect(() => models.resolve("text", "throwing/m")).toThrow(REFUSED);
  });

  it("warns when nobody hears that an instance failed to go offline", () => {
    const warn = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => undefined);
    const throwing = stubborn("throwing");
    throwing.setOffline = () => {
      throw new Error("stuck");
    };
    airplaneMode(new ModelManager({ providers: [throwing] })).set(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"throwing" failed to go offline'),
      { code: "FOUNDRY_MODELS_OFFLINE_FAILED" }
    );
    warn.mockRestore();
  });

  it("lifts its policy on dispose and announces policy changes", () => {
    const models = new ModelManager({ providers: [stubborn("cloud")] });
    const changed = vi.fn();
    models.events.on("policies-changed", changed);
    const airplane = airplaneMode(models);
    airplane.set(true);
    expect(airplane.enabled).toBe(true);
    airplane.dispose();
    expect(airplane.enabled).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(models.resolve("text", "cloud/m").provider).toBe("cloud");
  });

  it("refuses a second policy with the same id", () => {
    const models = new ModelManager();
    airplaneMode(models).set(true);
    expect(() => airplaneMode(models).set(true)).toThrow("already installed");
  });
});

describe("guarded models", () => {
  it("keep a class model's private state reachable through getters and calls", async () => {
    class PrivateModel {
      readonly #id = "private-m";
      readonly modelId = "m";
      readonly provider = "classy";
      readonly specificationVersion = "v4";
      get supportedUrls() {
        return { [this.#id]: [] };
      }
      doGenerate() {
        return Promise.resolve({ content: [{ text: this.#id, type: "text" }] });
      }
      doStream() {
        return Promise.reject(new Error(this.#id));
      }
    }
    const classy: Provider = {
      available: true,
      id: "classy",
      languageModel: () => new PrivateModel() as unknown as LanguageModelV4,
      models: [{ id: "m", kind: "text", modelId: "m" }],
      offline: false,
    };
    const model = new ModelManager({ providers: [classy] })
      .resolve("text", "classy/m")
      .open();
    expect(model.supportedUrls).toEqual({ "private-m": [] });
    await expect(model.doGenerate(CALL)).resolves.toMatchObject({
      content: [{ text: "private-m" }],
    });
  });
});

describe("review regressions", () => {
  it("delivers no buffered chunk after a refusal", async () => {
    const buffered: Provider = {
      ...stubborn("cloud"),
      languageModel: () => ({
        doGenerate: () => Promise.reject(new Error("unused")),
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream({
              start: (controller) => {
                for (const delta of ["1", "2", "3"]) {
                  controller.enqueue({ delta, id: "1", type: "text-delta" });
                }
                controller.close();
              },
            }),
          }),
        modelId: "m",
        provider: "cloud",
        specificationVersion: "v4",
        supportedUrls: {},
      }),
    };
    const models = new ModelManager({ providers: [buffered] });
    const { stream } = await models
      .resolve("text", "cloud/m")
      .open()
      .doStream(CALL);
    airplaneMode(models).set(true);
    await expect(stream.getReader().read()).rejects.toThrow(REFUSED);
  });

  it("guards every call a model offers, video jobs and webhooks included", async () => {
    const video = {
      doGenerate: () => Promise.resolve({ videos: [] }),
      doStart: () => Promise.resolve({ id: "job" }),
      doStatus: () => Promise.resolve({ status: "done" }),
      handleWebhookOption: () => ({ url: "https://example.test" }),
      modelId: "v",
      provider: "cloud",
      specificationVersion: "v4",
    };
    const studio: Provider = {
      ...stubborn("cloud"),
      models: [{ id: "v", kind: "video", modelId: "v" }],
      videoModel: () => video as never,
    };
    const models = new ModelManager({ providers: [studio] });
    const model = models.resolve("video", "cloud/v").open() as unknown as {
      doStart(options: object): Promise<unknown>;
      doStatus(options: object): Promise<unknown>;
      handleWebhookOption(): unknown;
    };
    airplaneMode(models).set(true);
    await expect(model.doStart({})).rejects.toThrow(REFUSED);
    await expect(model.doStatus({})).rejects.toThrow(REFUSED);
    expect(() => model.handleWebhookOption()).toThrow(REFUSED);
  });

  it("checks policies on open and hold even when already held", () => {
    const models = new ModelManager({ providers: [stubborn("cloud")] });
    const session = models.resolve("text", "cloud/m");
    session.hold();
    airplaneMode(models).set(true);
    expect(() => session.open()).toThrow(REFUSED);
    expect(() => session.hold()).toThrow(REFUSED);
  });

  it("names the refusing policy when nothing else can serve an empty selection", () => {
    const models = new ModelManager({ providers: [stubborn("cloud")] });
    airplaneMode(models).set(true);
    expect(() => models.resolve("text")).toThrow(REFUSED);
  });

  it("refuses live access granted through a provider handed out by the manager", async () => {
    const grant = vi.fn(() =>
      Promise.resolve({ expiresAt: 0, kind: "token" as const, token: "t" })
    );
    const live: Provider = { ...stubborn("cloud"), grant };
    const models = new ModelManager({ providers: [live] });
    airplaneMode(models).set(true);
    const [view] = models.providers;
    expect(() => view?.grant?.("m", "generate-video")).toThrow(REFUSED);
    expect(grant).not.toHaveBeenCalled();
  });

  it("cuts a grant pending when the policy is installed", async () => {
    const grant = vi.fn(() => new Promise<never>(() => undefined));
    const live: Provider = { ...stubborn("cloud"), grant };
    const models = new ModelManager({ providers: [live] });
    const pending = models.providers[0]?.grant?.("m", "generate-video");
    airplaneMode(models).set(true);
    await expect(pending).rejects.toThrow(REFUSED);
  });

  it("takes offline an instance that left while leased before it was turned on", () => {
    const leased = stubborn("leased");
    const models = new ModelManager({ providers: [leased] });
    const session = models.resolve("text", "leased/m");
    session.hold();
    models.setProviders([]);
    const airplane = airplaneMode(models);
    airplane.set(true);
    expect(leased.offlineCalls).toEqual([true]);
    airplane.set(false);
    expect(leased.offlineCalls).toEqual([true, false]);
    session.release();
  });

  it("brings back a leased instance that left, and forgets one disposed", async () => {
    const leased = stubborn("leased");
    const gone = stubborn("gone");
    const models = new ModelManager({ providers: [leased, gone] });
    const session = models.resolve("text", "leased/m");
    session.hold();
    const airplane = airplaneMode(models);
    airplane.set(true);
    models.setProviders([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    airplane.set(false);
    expect(leased.offlineCalls).toEqual([true, false]);
    expect(gone.offlineCalls).toEqual([true]);
    session.release();
  });
});

describe("guarded views", () => {
  function frozenModel(): LanguageModelV4 {
    const model = {
      doGenerate: () => Promise.resolve({ content: [] }),
      doStream: () => Promise.reject(new Error("unused")),
      modelId: "m",
      provider: "frozen",
      specificationVersion: "v4",
      supportedUrls: {},
    };
    Object.defineProperty(model, "doGenerate", {
      configurable: false,
      value: model.doGenerate,
      writable: false,
    });
    return Object.freeze(model) as unknown as LanguageModelV4;
  }

  it("guards a frozen model with non-configurable methods, with stable method identity", async () => {
    const frozen: Provider = {
      ...stubborn("frozen"),
      languageModel: () => frozenModel(),
    };
    const models = new ModelManager({ providers: [frozen] });
    const model = models.resolve("text", "frozen/m").open();
    expect(model.doGenerate).toBe(model.doGenerate);
    await expect(model.doGenerate(CALL)).resolves.toEqual({ content: [] });
    airplaneMode(models).set(true);
    await expect(model.doGenerate(CALL)).rejects.toThrow(REFUSED);
  });

  it("rejects a refused async method and throws for a refused synchronous one", async () => {
    const extra = {
      describe: () => "sync",
      modelId: "v",
      async preview() {
        return await Promise.resolve("async");
      },
      provider: "cloud",
      specificationVersion: "v4",
    };
    const cloud: Provider = {
      ...stubborn("cloud"),
      models: [{ id: "v", kind: "video", modelId: "v" }],
      videoModel: () => extra as never,
    };
    const models = new ModelManager({ providers: [cloud] });
    const model = models.resolve("video", "cloud/v").open() as unknown as {
      describe(): string;
      preview(): Promise<string>;
    };
    airplaneMode(models).set(true);
    const pending = model.preview();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(REFUSED);
    expect(() => model.describe()).toThrow(REFUSED);
  });

  it("identifies providers by instance id: views are stable, not the supplied objects, and unwrap in any manager", () => {
    const cloud = stubborn("cloud");
    const first = new ModelManager({ providers: [cloud] });
    const [view] = first.providers;
    expect(view).not.toBe(cloud);
    expect(view?.id).toBe("cloud");
    expect(first.providers[0]).toBe(view);

    const second = new ModelManager({ providers: first.providers });
    airplaneMode(first).set(true);
    expect(second.resolve("text", "cloud/m").provider).toBe("cloud");
  });
});
