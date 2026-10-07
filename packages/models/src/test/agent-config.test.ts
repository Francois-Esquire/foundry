import { Config } from "@foundry/lib/config";
import { describe, expect, it } from "vitest";

import { AgentConfig } from "../config";

describe("AgentConfig — validates its own config", () => {
  it("rejects an invalid write and leaves the prior value unchanged", () => {
    const c = new AgentConfig({ maxTokens: 100 });
    expect(() => {
      c.set("maxTokens", "lots" as unknown as number);
    }).toThrow();
    expect(c.get("maxTokens")).toBe(100);
  });

  it("validates kind defaults, the routing the manager reads", () => {
    const c = new AgentConfig();
    c.set("defaults", { text: { modelId: "m", provider: "p" } });
    expect(() => {
      c.set("defaults", { txt: { provider: "p" } } as never);
    }).toThrow();
    expect(() => {
      c.set("defaults.text", { modelId: "m" } as never);
    }).toThrow();
    expect(c.get("defaults")).toEqual({
      text: { modelId: "m", provider: "p" },
    });
  });

  it("refuses invalid initial values at construction, not on a later write", () => {
    expect(
      () =>
        new AgentConfig({
          defaults: { text: { modelId: null, provider: "p" } },
        } as never)
    ).toThrow();
  });

  it("validates a patch like a set", () => {
    const c = new AgentConfig({ maxTokens: 100 });
    expect(() => {
      c.patch({ maxTokens: "lots" });
    }).toThrow();
    expect(c.get("maxTokens")).toBe(100);
  });
});

describe("AgentConfig — mountable into a global Config", () => {
  it("reads through the mounted prefix", () => {
    const global = new Config();
    const models = new AgentConfig({ maxTokens: 4096 });
    global.mount("models", models);
    expect(global.get("models.maxTokens")).toBe(4096);
  });

  it("validates a through-mount write against the child's own schema", () => {
    const global = new Config();
    const models = new AgentConfig({ maxTokens: 4096 });
    global.mount("models", models);
    expect(() => {
      global.set("models.maxTokens", "bad" as unknown as number);
    }).toThrow();
    expect(models.get("maxTokens")).toBe(4096);
  });

  it("keeps the child reference live: parent writes land on it, and it survives detach", () => {
    const global = new Config();
    const models = new AgentConfig({ maxTokens: 4096 });
    global.mount("models", models);

    global.set("models.maxTokens", 8192);
    expect(models.get("maxTokens")).toBe(8192); // same instance updated

    global.detach("models");
    models.set("maxTokens", 1024); // still fully usable standalone
    expect(models.get("maxTokens")).toBe(1024);
    expect(global.get("models.maxTokens")).toBeUndefined(); // parent dropped it
  });
});
