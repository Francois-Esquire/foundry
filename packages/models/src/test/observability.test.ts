import { afterEach, describe, expect, it } from "vitest";

import {
  configureModelObservability,
  isModelObservabilityEnabled,
  modelAudit,
  withAiLogger,
} from "../observability";

interface AiField {
  calls?: number;
  embedding?: { tokens?: number };
  estimatedCost?: number;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  toolCalls?: string[];
  totalTokens?: number;
}

function drainEvents(events: { ai?: AiField }[]) {
  configureModelObservability({
    enabled: true,
    logger: {
      drain: (ctx) => {
        events.push(ctx.event as { ai?: AiField });
      },
    },
  });
}

afterEach(() => {
  configureModelObservability({ enabled: true });
});

describe("model observability", () => {
  it("runs the body and returns its result when enabled", async () => {
    configureModelObservability({ enabled: true });
    expect(isModelObservabilityEnabled()).toBe(true);

    const result = await withAiLogger({ operation: "unit" }, (session) => {
      expect(typeof session.wrap).toBe("function");
      expect(typeof session.captureEmbed).toBe("function");
      return Promise.resolve(42);
    });

    expect(result).toBe(42);
  });

  it("emits the wide event even when the body throws", async () => {
    configureModelObservability({ enabled: true });

    await expect(
      withAiLogger({ operation: "boom" }, () =>
        Promise.reject(new Error("kaboom"))
      )
    ).rejects.toThrow("kaboom");
  });

  it("wrap is identity and captureEmbed a no-op when disabled", async () => {
    configureModelObservability({ enabled: false });
    expect(isModelObservabilityEnabled()).toBe(false);

    const sentinel = { id: "model" };
    const out = await withAiLogger({ operation: "off" }, (session) => {
      expect(session.wrap(sentinel as never)).toBe(sentinel);
      session.captureEmbed({ usage: { tokens: 0 } });
      return Promise.resolve("done");
    });

    expect(out).toBe("done");
  });

  it("emits a wide event through the configured drain (full chain)", async () => {
    const events: { ai?: AiField }[] = [];
    drainEvents(events);

    await withAiLogger({ operation: "embed" }, (session) => {
      session.captureEmbed({ model: "test-embed", usage: { tokens: 100 } });
      return Promise.resolve();
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.ai?.embedding?.tokens).toBe(100);
  });

  it("accepts cost overrides", () => {
    expect(() => {
      configureModelObservability({
        cost: { "custom/model": { input: 1, output: 2 } },
      });
    }).not.toThrow();
  });
});

describe("modelAudit catalog", () => {
  it("prefixes actions and fixes the target type", () => {
    const input = modelAudit.MODEL_DOWNLOAD({
      actor: { id: "models", type: "system" },
      target: { id: "Xenova/all-MiniLM-L6-v2" },
    });
    expect(input.action).toBe("models.MODEL_DOWNLOAD");
    expect(input.target?.type).toBe("model");
    expect(input.target?.id).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("exposes the default target on the factory", () => {
    expect(modelAudit.PROVIDER_CONFIGURE.target).toBe("provider");
  });
});
