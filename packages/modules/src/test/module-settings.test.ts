import { describe, expect, it } from "vitest";

import {
  type ModuleManifest,
  moduleSettingRequests,
  parseModuleManifest,
} from "../manifest";
import {
  MODULE_SETTING_HOST_POLICY,
  ModuleSettingsError,
  type ModuleSettingsHostPolicy,
  type ModuleSettingValues,
  parseModuleSettingValues,
  requireModuleSettings as requireRequests,
  resolveModuleSettings as resolveRequests,
  withModuleSettingDefaults,
} from "../settings";
import { STRICT_MANIFEST, VALID_MANIFEST } from "./helpers/module-fixture";

const GIB = 1024 * 1024 * 1024;
const legacy = parseModuleManifest(VALID_MANIFEST);

function strict(change: object) {
  return parseModuleManifest({ ...STRICT_MANIFEST, ...change });
}

interface ManifestSettingsInput {
  readonly manifest: ModuleManifest | null;
  readonly policy?: ModuleSettingsHostPolicy;
  readonly user?: ModuleSettingValues;
}

/** Settings resolved against what `manifest` requests. */
function resolveModuleSettings({ manifest, ...input }: ManifestSettingsInput) {
  return resolveRequests({
    ...input,
    requests: moduleSettingRequests(manifest),
  });
}

function requireModuleSettings({ manifest, ...input }: ManifestSettingsInput) {
  return requireRequests({
    ...input,
    requests: moduleSettingRequests(manifest),
  });
}

function problems(input: ManifestSettingsInput) {
  const resolution = resolveModuleSettings(input);
  return resolution.ok ? [] : resolution.problems.map((p) => p.message);
}

describe("Module settings resolution", () => {
  it("gives a Module that declares nothing the host defaults", () => {
    for (const manifest of [null, legacy]) {
      const effective = requireModuleSettings({ manifest });
      expect(effective).toMatchObject({
        "authoring.deadline": 600_000,
        "authoring.maxSteps": 20,
        "authoring.source.maxBytes": 16_777_216,
        "queues.authoring.concurrency": 1,
        "queues.workflows.concurrency": 1,
        "resources.cpus": 1,
        "resources.memoryBytes": 2 * GIB,
        "sandbox.idlePolicy": "keep-on",
      });
    }
  });

  it("takes Manifest defaults, then user values over them", () => {
    const manifest = strict({});
    expect(requireModuleSettings({ manifest })).toMatchObject({
      "authoring.maxSteps": 10,
      "queues.workflows.concurrency": 2,
    });
    expect(
      requireModuleSettings({
        manifest,
        user: { "authoring.maxSteps": 15, "queues.workflows.concurrency": 4 },
      })
    ).toMatchObject({
      "authoring.maxSteps": 15,
      "queues.workflows.concurrency": 4,
    });
  });

  it("caps a Manifest default at the host ceiling", () => {
    expect(
      requireModuleSettings({
        manifest: strict({
          settings: { "queues.workflows.concurrency": { default: 64 } },
        }),
      })["queues.workflows.concurrency"]
    ).toBe(4);
  });

  it("raises the host default to a Manifest minimum, and resources are minimums", () => {
    const manifest = strict({
      resources: { cpus: 2, memoryBytes: 256 * 1024 * 1024 },
      settings: { "explorer.pageSize": { minimum: 50 } },
    });
    const effective = requireModuleSettings({
      manifest,
      policy: withModuleSettingDefaults({ "resources.memoryBytes": GIB / 8 }),
    });
    expect(effective["resources.cpus"]).toBe(2);
    expect(effective["resources.memoryBytes"]).toBe(256 * 1024 * 1024);
    expect(effective["explorer.pageSize"]).toBe(100);
    // A smaller minimum never lowers a larger default.
    expect(requireModuleSettings({ manifest })["resources.memoryBytes"]).toBe(
      2 * GIB
    );
  });

  it("rejects a minimum the host cannot meet instead of underprovisioning", () => {
    const manifest = strict({ resources: { memoryBytes: 4 * GIB } });
    expect(resolveModuleSettings({ manifest }).ok).toBe(false);
    expect(problems({ manifest })).toEqual([
      `The Module requires resources.memoryBytes of at least ${4 * GIB} bytes; this host allows at most ${2 * GIB}`,
    ]);
    expect(() => requireModuleSettings({ manifest })).toThrow(
      ModuleSettingsError
    );
  });

  it("rejects user values below the Manifest minimum or above the ceiling", () => {
    const manifest = strict({ resources: { cpus: 2 } });
    expect(problems({ manifest, user: { "resources.cpus": 1 } })).toEqual([
      "resources.cpus is set to 1 CPUs; the Module requires at least 2",
    ]);
    expect(
      problems({
        manifest: null,
        user: { "queues.authoring.concurrency": 2 },
      })
    ).toEqual([
      "queues.authoring.concurrency is set to 2 runs; this host allows at most 1",
    ]);
  });

  it("keeps authoring concurrency at one: the host ceiling is 1", () => {
    expect(
      MODULE_SETTING_HOST_POLICY["queues.authoring.concurrency"].ceiling
    ).toBe(1);
    expect(
      requireModuleSettings({
        manifest: strict({
          settings: { "queues.authoring.concurrency": { default: 3 } },
        }),
      })["queues.authoring.concurrency"]
    ).toBe(1);
    expect(
      problems({
        manifest: strict({
          settings: { "queues.authoring.concurrency": { minimum: 2 } },
        }),
      })
    ).toHaveLength(1);
  });
});

describe("Module setting user values", () => {
  it("accepts and orders valid values", () => {
    expect(
      Object.keys(
        parseModuleSettingValues({
          "authoring.maxSteps": 5,
          "resources.cpus": 1.5,
        })
      )
    ).toEqual(["authoring.maxSteps", "resources.cpus"]);
  });

  it.each([
    ["network", 1, "network is authority, not a setting"],
    ["host.operations", 1, "host.operations is authority, not a setting"],
    ["artifacts.access", 1, "artifacts.access is authority, not a setting"],
    ["sandbox.idlePolicy", 1, "sandbox.idlePolicy is fixed"],
    ["theme", 1, "theme is not a Module setting"],
    ["authoring.maxSteps", 0, "must be a positive integer"],
    ["authoring.maxSteps", "5", "must be a positive integer"],
    ["resources.memoryBytes", 3 * GIB, "this host allows at most"],
  ])("rejects %s = %s", (key, value, message) => {
    expect(() => parseModuleSettingValues({ [key]: value })).toThrow(message);
  });

  it("rejects input that is not an object", () => {
    expect(() => parseModuleSettingValues([])).toThrow(ModuleSettingsError);
  });
});
