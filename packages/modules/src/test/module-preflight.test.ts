import { contentIdSchema } from "@foundry/artifacts";
import { digestJson } from "@foundry/lib/digest";
import { describe, expect, it } from "vitest";

import { installationIdSchema, moduleIdSchema } from "../domain";
import type { ModuleCapabilityProvider } from "../gateway/types";
import { PORTABLE_SCHEMA_DIALECT, parseModuleManifest } from "../manifest";
import { preflightModuleActivation } from "../preflight";
import type { InstallationGrant } from "../store/contract";
import { STRICT_MANIFEST, VALID_MANIFEST } from "./helpers/module-fixture";

const GIB = 1024 * 1024 * 1024;
const principal = {
  contentId: contentIdSchema.parse("content-1"),
  generation: 1,
  installationId: installationIdSchema.parse("installation-1"),
  moduleId: moduleIdSchema.parse("module-1"),
};
const objectSchema = { $schema: PORTABLE_SCHEMA_DIALECT, type: "object" };
const schema = {
  description: objectSchema,
  parse: (value: unknown) => value,
} as const;

function version(change: object = {}) {
  return {
    manifest: parseModuleManifest({
      ...VALID_MANIFEST,
      capabilities: [
        {
          alias: "weather",
          capability: "host.network.fetch",
          constraints: { hosts: ["api.example.com"] },
          reason: "Loads forecasts",
          required: false,
          version: 1,
        },
      ],
      ...change,
    }),
  };
}

function provider(
  resolveConstraints: ModuleCapabilityProvider["resolveConstraints"]
): ModuleCapabilityProvider {
  return {
    registration: {
      descriptor: {
        capability: "host.network.fetch",
        documentation: "Fetch.",
        input: objectSchema,
        output: objectSchema,
        version: 1,
      },
      input: schema,
      invoke: () => Promise.resolve({}),
      mode: "unary",
      output: schema,
    },
    resolveConstraints,
  } as unknown as ModuleCapabilityProvider;
}

function grant(constraintsDigest: string): InstallationGrant {
  return {
    capability: "host.network.fetch",
    constraintsDigest,
    createdAt: new Date(0),
    version: 1,
  };
}

describe("Module activation preflight", () => {
  it("matches Grants by the provider's resolved digest, not the raw constraints", async () => {
    const seen: unknown[] = [];
    const fetch = provider((input) => {
      seen.push(input);
      return Promise.resolve({ constraintsDigest: "policy:api.example.com" });
    });
    const raw = await digestJson({ hosts: ["api.example.com"] });

    const approved = await preflightModuleActivation({
      grants: [grant("policy:api.example.com")],
      principal,
      providers: [fetch],
      version: version(),
    });
    expect(approved).toEqual({ additions: [], compatible: true, facts: [] });
    expect(seen).toEqual([
      {
        principal,
        releaseConstraints: { hosts: ["api.example.com"] },
      },
    ]);

    const rawOnly = await preflightModuleActivation({
      grants: [grant(raw)],
      principal,
      providers: [fetch],
      version: version(),
    });
    expect(rawOnly.additions).toMatchObject([
      { alias: "weather", capability: "host.network.fetch" },
    ]);
  });

  it("disables an optional unavailable or denied Capability without blocking", async () => {
    const unavailable = await preflightModuleActivation({
      grants: [],
      principal,
      providers: [],
      version: version(),
    });
    expect(unavailable).toEqual({
      additions: [],
      compatible: true,
      facts: [
        {
          blocking: false,
          detail: "Host does not provide host.network.fetch@1",
          kind: "unknown-capability",
        },
      ],
    });

    const denied = await preflightModuleActivation({
      grants: [],
      principal,
      providers: [provider(() => Promise.reject(new Error("no")))],
      version: version(),
    });
    expect(denied.compatible).toBe(true);
    expect(denied.facts).toMatchObject([
      { blocking: false, kind: "denied-capability" },
    ]);
  });

  it("blocks the start when a required Capability is unavailable or denied", async () => {
    const required = version({
      capabilities: [
        {
          alias: "weather",
          capability: "host.network.fetch",
          reason: "Loads forecasts",
          required: true,
          version: 1,
        },
      ],
    });
    for (const providers of [
      [],
      [provider(() => Promise.reject(new Error("no")))],
    ]) {
      const report = await preflightModuleActivation({
        grants: [],
        principal,
        providers,
        version: required,
      });
      expect(report.compatible).toBe(false);
      expect(report.additions).toEqual([]);
    }
  });

  it("blocks the start until a required Capability is approved; optional ones only list approval work", async () => {
    const required = version({
      capabilities: [
        {
          alias: "weather",
          capability: "host.network.fetch",
          reason: "Loads forecasts",
          required: true,
          version: 1,
        },
      ],
    });
    const fetch = provider(() =>
      Promise.resolve({ constraintsDigest: "policy" })
    );
    const missing = await preflightModuleActivation({
      grants: [],
      principal,
      providers: [fetch],
      version: required,
    });
    expect(missing).toMatchObject({
      additions: [{ alias: "weather", required: true }],
      compatible: false,
      facts: [{ blocking: true, kind: "ungranted-capability" }],
    });
    await expect(
      preflightModuleActivation({
        grants: [grant("policy")],
        principal,
        providers: [fetch],
        version: required,
      })
    ).resolves.toEqual({ additions: [], compatible: true, facts: [] });
    await expect(
      preflightModuleActivation({
        grants: [],
        principal,
        providers: [fetch],
        version: version(),
      })
    ).resolves.toMatchObject({
      additions: [{ alias: "weather", required: false }],
      compatible: true,
      facts: [],
    });
  });

  it("blocks unsupported runtime and resource requirements before launching", async () => {
    const storage = await preflightModuleActivation({
      grants: [],
      principal,
      providers: [],
      version: {
        manifest: parseModuleManifest({
          ...STRICT_MANIFEST,
          resources: { storageBytes: GIB },
        }),
      },
    });
    expect(storage.compatible).toBe(false);
    expect(storage.facts).toEqual([
      {
        blocking: true,
        detail:
          "The Module requires a hard storage limit (resources.storageBytes), which this host's sandbox cannot enforce",
        kind: "unsupported-requirement",
      },
    ]);
    expect(
      (
        await preflightModuleActivation({
          grants: [],
          principal,
          providers: [],
          runtime: { storageBytes: true },
          version: {
            manifest: parseModuleManifest({
              ...STRICT_MANIFEST,
              resources: { storageBytes: GIB },
            }),
          },
        })
      ).compatible
    ).toBe(true);

    const memory = await preflightModuleActivation({
      grants: [],
      principal,
      providers: [],
      version: {
        manifest: parseModuleManifest({
          ...STRICT_MANIFEST,
          resources: { memoryBytes: 8 * GIB },
        }),
      },
    });
    expect(memory.compatible).toBe(false);
    expect(memory.facts[0]?.detail).toContain("resources.memoryBytes");

    const user = await preflightModuleActivation({
      grants: [],
      principal,
      providers: [],
      settings: { user: { "resources.memoryBytes": 128 * 1024 * 1024 } },
      version: { manifest: parseModuleManifest(STRICT_MANIFEST) },
    });
    expect(user.compatible).toBe(false);
  });
});
