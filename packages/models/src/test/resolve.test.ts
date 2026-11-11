import { describe, expect, it, vi } from "vitest";
import { ModelManager } from "../manager";
import { formatSelection } from "../selection";
import type { ProviderModelDefinition } from "../types";
import { fakeProvider } from "./helpers/model";

const text = (id: string): ProviderModelDefinition => ({
  id,
  kind: "text",
  modelId: `wire/${id}`,
});

function codexBeforeVercel() {
  const codex = fakeProvider("codex", {
    defaults: {},
    models: [text("gpt-5.5")],
  });
  const vercel = fakeProvider("vercel", {
    defaults: {},
    models: [
      text("gpt-5.5"),
      text("openai/gpt-5-mini"),
      { id: "embed-small", kind: "embedding", modelId: "wire/embed-small" },
    ],
  });
  return {
    codex,
    models: new ModelManager({ providers: [codex, vercel] }),
    vercel,
  };
}

describe("resolve", () => {
  it("serves an unqualified model from the first provider in order that lists it", () => {
    const { models } = codexBeforeVercel();
    const route = models.resolve("text", "gpt-5.5");
    expect(route.route).toEqual({ model: "gpt-5.5", provider: "codex" });
  });

  it("follows a new order for new resolutions", () => {
    const { codex, models, vercel } = codexBeforeVercel();
    models.setProviders([vercel, codex]);
    expect(models.resolve("text", "gpt-5.5").provider).toBe("vercel");
  });

  it("takes a qualified string or object without falling back", () => {
    const { models } = codexBeforeVercel();
    expect(models.resolve("text", "vercel/gpt-5.5").provider).toBe("vercel");
    expect(
      models.resolve("text", { model: "gpt-5.5", provider: "vercel" }).provider
    ).toBe("vercel");
    expect(() => models.resolve("text", "codex/openai/gpt-5-mini")).toThrow(
      "No configured provider lists"
    );
  });

  it("reads a slash as a model id when no provider has that prefix", () => {
    const { models } = codexBeforeVercel();
    expect(models.resolve("text", "openai/gpt-5-mini").route).toEqual({
      model: "openai/gpt-5-mini",
      provider: "vercel",
    });
  });

  it("refuses a string both readings match", () => {
    const openai = fakeProvider("openai", {
      defaults: {},
      models: [text("gpt-5-mini")],
    });
    const { codex, models, vercel } = codexBeforeVercel();
    models.setProviders([openai, codex, vercel]);
    expect(() => models.resolve("text", "openai/gpt-5-mini")).toThrow(
      "name it as { provider, model }"
    );
  });

  it("refuses ids no catalog lists, naming what was searched", () => {
    const { models } = codexBeforeVercel();
    expect(() => models.resolve("text", "gpt-5.6-preview")).toThrow(
      "searched: codex, vercel"
    );
    expect(() => models.resolve("text", "claude-work/opus")).toThrow(
      "No configured provider lists"
    );
    expect(() => models.resolve("text", { provider: "claude-work" })).toThrow(
      'Provider "claude-work" is not configured'
    );
  });

  it("refuses a model of another kind", () => {
    const { models } = codexBeforeVercel();
    expect(() => models.resolve("text", "embed-small")).toThrow(
      'is kind "embedding", expected "text"'
    );
  });

  it("skips unavailable providers for an unqualified selection, and refuses one named", () => {
    const { codex, models } = codexBeforeVercel();
    codex.available = false;
    expect(models.resolve("text", "gpt-5.5").provider).toBe("vercel");
    expect(() => models.resolve("text", "codex/gpt-5.5")).toThrow(
      'Provider "codex" is unavailable'
    );
    models.setProviders([codex]);
    expect(() => models.resolve("text", "gpt-5.5")).toThrow(
      "skipped: codex (unavailable)"
    );
  });

  it("uses a provider's default, else its first row, and the first serving provider", () => {
    const local = fakeProvider("local", {
      defaults: { embedding: "embed-large" },
      models: [
        { id: "embed-small", kind: "embedding", modelId: "e1" },
        { id: "embed-large", kind: "embedding", modelId: "e2" },
      ],
    });
    const { codex, models } = codexBeforeVercel();
    models.setProviders([codex, local]);
    expect(models.resolve("embedding", { provider: "local" }).model).toBe(
      "embed-large"
    );
    expect(models.resolve("embedding").provider).toBe("local");
    expect(models.resolve("text", { provider: "codex" }).model).toBe("gpt-5.5");
    expect(() => models.resolve("image")).toThrow("no image model");
  });

  it("exposes the row, turn limit, and a route that formats back to a selection", () => {
    const { models } = codexBeforeVercel();
    const route = models.resolve("text", "gpt-5.5");
    expect(route.definition.modelId).toBe("wire/gpt-5.5");
    expect(route.turnLimit).toBe("steps");
    expect(formatSelection(route.route)).toBe("codex/gpt-5.5");
  });
});

describe("open, leases, and disposal", () => {
  it("builds the model on the instance it resolved, with its route", () => {
    const { codex, models } = codexBeforeVercel();
    const model = models.resolve("text", "gpt-5.5").open();
    expect(codex.calls).toEqual(["text:wire/gpt-5.5"]);
    expect(model.route).toEqual({ id: "gpt-5.5", provider: "codex" });
  });

  it("refuses a native turn limit unless the route enforces one natively", () => {
    const { models } = codexBeforeVercel();
    expect(() =>
      models.resolve("text", "gpt-5.5").open({ nativeMaxTurns: 3 })
    ).toThrow("a native turn limit");
  });

  it("keeps a leased instance after it leaves the set and disposes it on release", async () => {
    const { codex, models, vercel } = codexBeforeVercel();
    const session = models.resolve("text", "gpt-5.5");
    session.open();
    models.setProviders([vercel]);
    expect(codex.disposed).toBe(0);
    expect(models.resolve("text", "gpt-5.5").provider).toBe("vercel");
    session.open();
    session.release();
    await vi.waitFor(() => expect(codex.disposed).toBe(1));
  });

  it("disposes an unleased instance as soon as it leaves", async () => {
    const { codex, models, vercel } = codexBeforeVercel();
    models.resolve("text", "gpt-5.5");
    models.setProviders([vercel]);
    await vi.waitFor(() => expect(codex.disposed).toBe(1));
  });

  it("refuses to open a resolution whose instance left before any lease", () => {
    const { models, vercel } = codexBeforeVercel();
    const stale = models.resolve("text", "gpt-5.5");
    models.setProviders([vercel]);
    expect(() => stale.open()).toThrow("left the provider set");
    expect(() => stale.hold()).toThrow("left the provider set");
  });

  it("keeps an instance that stays in the set untouched", () => {
    const { codex, models, vercel } = codexBeforeVercel();
    models.setProviders([vercel, codex]);
    expect(codex.disposed).toBe(0);
  });

  it("reports a disposal that fails", async () => {
    const { codex, models, vercel } = codexBeforeVercel();
    codex.dispose = () => Promise.reject(new Error("stuck"));
    const failed = vi.fn();
    models.events.on("dispose-failed", failed);
    models.setProviders([vercel]);
    await vi.waitFor(() =>
      expect(failed).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "codex" })
      )
    );
  });

  it("refuses a set that names an id twice", () => {
    const { codex, models } = codexBeforeVercel();
    expect(() => models.setProviders([codex, codex])).toThrow("once");
  });
});

describe("open per kind", () => {
  it("builds each kind on its row's wire id", () => {
    const media = fakeProvider("media", {
      defaults: {},
      kinds: [
        "embedding",
        "image",
        "speech",
        "transcription",
        "video",
        "media",
      ],
      models: [
        { id: "e", kind: "embedding", modelId: "wire-e" },
        { id: "i", kind: "image", modelId: "wire-i" },
        { id: "s", kind: "speech", modelId: "wire-s" },
        { id: "t", kind: "transcription", modelId: "wire-t" },
        { id: "v", kind: "video", modelId: "wire-v" },
        { id: "m", kind: "music", modelId: "wire-m" },
      ],
    });
    const models = new ModelManager({ providers: [media] });
    models.resolve("embedding", "e").open();
    models.resolve("image", "i").open();
    models.resolve("speech", "s").open();
    models.resolve("transcription", "t").open();
    models.resolve("video", "v").open();
    models.resolve("music", "m").open();
    expect(media.calls).toEqual([
      "embedding:wire-e",
      "image:wire-i",
      "speech:wire-s",
      "transcription:wire-t",
      "video:wire-v",
    ]);
  });

  it("refuses a kind the instance cannot build, and takes no lease for it", async () => {
    const bare = fakeProvider("bare", {
      defaults: {},
      kinds: [],
      models: [{ id: "i", kind: "image", modelId: "wire-i" }],
    });
    const models = new ModelManager({ providers: [bare] });
    expect(() => models.resolve("image", "i").open()).toThrow(
      "does not support image models"
    );
    models.setProviders([]);
    await vi.waitFor(() => expect(bare.disposed).toBe(1));
  });

  it("states the text model's window from its catalog row", () => {
    const sized = fakeProvider("sized", {
      defaults: {},
      models: [
        {
          id: "big",
          kind: "text",
          limits: { maxInputTokens: 1000, maxOutputTokens: 100 },
          modelId: "wire-big",
        },
      ],
    });
    const model = new ModelManager({ providers: [sized] })
      .resolve("text", "big")
      .open({ workingDirectory: "/repo" });
    expect(model.limits).toEqual({ contextWindow: 1000, maxOutputTokens: 100 });
  });

  it("disposes every instance even when one fails", async () => {
    const failing = fakeProvider("failing");
    failing.dispose = () => Promise.reject(new Error("stuck"));
    const fine = fakeProvider("fine");
    await new ModelManager({ providers: [failing, fine] }).dispose();
    expect(fine.disposed).toBe(1);
  });
});

describe("review regressions", () => {
  it("keeps a leased instance that left and came back, and disposes it once", async () => {
    const { codex, models, vercel } = codexBeforeVercel();
    const session = models.resolve("text", "codex/gpt-5.5");
    session.hold();
    models.setProviders([vercel]);
    models.setProviders([codex, vercel]);
    session.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(codex.disposed).toBe(0);
    await models.dispose();
    expect(codex.disposed).toBe(1);
  });

  it("keeps setProviders and release synchronous when a dispose throws", async () => {
    const { codex, models, vercel } = codexBeforeVercel();
    codex.dispose = () => {
      throw new Error("boom");
    };
    const failed = vi.fn();
    models.events.on("dispose-failed", failed);
    models.setProviders([vercel]);
    expect(models.providers.map((provider) => provider.id)).toEqual(["vercel"]);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
  });

  it("finds the row of the asked kind when one id is listed under two kinds", () => {
    const both = fakeProvider("a", {
      defaults: {},
      kinds: ["image", "video"],
      models: [
        { id: "x", kind: "image", modelId: "x-image" },
        { id: "x", kind: "video", modelId: "x-video" },
      ],
    });
    const models = new ModelManager({ providers: [both] });
    for (const selection of ["x", "a/x", { model: "x", provider: "a" }]) {
      expect(models.resolve("video", selection).definition.modelId).toBe(
        "x-video"
      );
    }
  });

  it("hands out guarded views that go straight back into setProviders", () => {
    const { codex, models } = codexBeforeVercel();
    models.setProviders(models.providers);
    expect(codex.disposed).toBe(0);
    expect(models.providers.map((provider) => provider.id)).toEqual([
      "codex",
      "vercel",
    ]);
  });
});
