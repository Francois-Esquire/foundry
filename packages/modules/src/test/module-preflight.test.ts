import { describe, expect, it } from "vitest";

import type { ModuleVersion } from "../domain";
import { preflightModuleActivation } from "../preflight";

const version = {
  manifest: {
    capabilities: [
      {
        alias: "weather",
        capability: "host.network.fetch",
        required: false,
        version: 1,
      },
    ],
    compatibility: { gateway: "1", runtime: "bun@1" },
  },
} as unknown as ModuleVersion;

describe("Module activation preflight", () => {
  it("reports facts without starting code and requests only missing authority", async () => {
    const report = await preflightModuleActivation({
      capabilities: [{ capability: "host.network.fetch", version: 1 }],
      grants: [],
      version,
    });
    expect(report).toMatchObject({
      additions: [{ alias: "weather", capability: "host.network.fetch" }],
      compatible: true,
      facts: [],
    });
  });

  it("does not let a missing capability become approval work", async () => {
    const report = await preflightModuleActivation({
      capabilities: [],
      grants: [],
      version,
    });
    expect(report.compatible).toBe(false);
    expect(report.facts).toEqual([
      {
        detail: "Host does not provide host.network.fetch@1",
        kind: "unknown-capability",
      },
    ]);
    expect(report.additions).toEqual([]);
  });
});
