import { describe, expect, it, vi } from "vitest";

import type * as LoggerModule from "../logger";
import type { ProviderModelDefinition } from "../types";

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

function discovering(id: string, rows: ProviderModelDefinition[]) {
  const discover = vi.fn(() => Promise.resolve(rows));
  return { discover, provider: fakeProvider(id, { discover }) };
}

describe("ModelManager.init", () => {
  it("runs every provider's discovery and replaces its catalog", async () => {
    const a = discovering("a", [{ id: "live", kind: "text", modelId: "live" }]);
    const b = discovering("b", [
      { id: "other", kind: "text", modelId: "other" },
    ]);
    const manager = new ModelManager({ providers: [a.provider, b.provider] });

    const discovered = await manager.init();

    expect(a.discover).toHaveBeenCalledTimes(1);
    expect(b.discover).toHaveBeenCalledTimes(1);
    expect(a.provider.models.map((m) => m.id)).toEqual(["live"]);
    expect([...discovered.keys()]).toEqual(["a", "b"]);
  });

  it("keeps the floor when discovery returns nothing", async () => {
    const a = discovering("a", []);
    const manager = new ModelManager({ providers: [a.provider] });
    const discovered = await manager.init();
    expect(a.provider.models.map((m) => m.id)).toEqual(["smart", "embed"]);
    expect(discovered.has("a")).toBe(false);
  });

  it("tolerates a per-provider failure — the rest still discover and init() resolves", async () => {
    const bad = fakeProvider("bad", {
      discover: () => Promise.reject(new Error("bad boom")),
    });
    const good = discovering("good", [{ id: "g", kind: "text", modelId: "g" }]);
    const manager = new ModelManager({ providers: [bad, good.provider] });

    const discovered = await manager.init();

    expect(bad.models.map((m) => m.id)).toEqual(["smart", "embed"]);
    expect(discovered.has("good")).toBe(true);
  });

  it("in Airplane Mode discovers nothing — discovery is a live call", async () => {
    const a = discovering("a", [{ id: "live", kind: "text", modelId: "live" }]);
    const manager = new ModelManager({ providers: [a.provider] });
    manager.setOfflineMode(true);

    await manager.init();

    expect(a.discover).not.toHaveBeenCalled();
  });

  it("feeds discovered pricing into the observability cost map", async () => {
    const a = discovering("a", [
      {
        costs: { input: 5, output: 10 },
        id: "disc",
        kind: "text",
        modelId: "vendor/disc",
      },
    ]);
    const manager = new ModelManager({ providers: [a.provider] });
    await manager.init();

    expect(configureModelObservability).toHaveBeenLastCalledWith({
      cost: expect.objectContaining({
        "vendor/disc": { input: 5, output: 10 },
      }) as Record<string, unknown>,
    });
  });

  it("emits catalog-changed exactly once after init settles", async () => {
    const manager = new ModelManager({ providers: [fakeProvider("a")] });
    let changed = 0;
    manager.events.on("catalog-changed", () => {
      changed += 1;
    });
    await manager.init();
    expect(changed).toBe(1);
  });
});
