import { afterEach, describe, expect, it } from "vitest";

import {
  beginTurnObservation,
  configureModelObservability,
  isModelObservabilityEnabled,
  observeAgentTurn,
} from "../observability";

afterEach(() => {
  configureModelObservability({ enabled: true });
});

describe("model observability", () => {
  it("follows the enabled switch", () => {
    configureModelObservability({ enabled: false });
    expect(isModelObservabilityEnabled()).toBe(false);
    expect(beginTurnObservation()).toBeNull();
    expect(
      observeAgentTurn({ model: { id: "m" }, sessionId: "s" } as never)
    ).toBeNull();

    configureModelObservability({ enabled: true });
    expect(isModelObservabilityEnabled()).toBe(true);
  });

  it("observes an agent turn through the configured drain", () => {
    const events: { model?: string; sessionId?: string }[] = [];
    configureModelObservability({
      enabled: true,
      logger: {
        drain: (ctx) => {
          events.push(ctx.event as { model?: string; sessionId?: string });
        },
      },
    });

    observeAgentTurn({ model: { id: "m" }, sessionId: "s" } as never)?.emit();

    expect(events).toMatchObject([{ model: "m", sessionId: "s" }]);
  });

  it("accepts cost overrides", () => {
    expect(() => {
      configureModelObservability({
        cost: { "custom/model": { input: 1, output: 2 } },
      });
    }).not.toThrow();
  });
});
