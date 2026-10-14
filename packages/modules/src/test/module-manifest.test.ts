import type { StorageTree } from "@foundry/core/storage";
import { digestJson } from "@foundry/lib/digest";
import { containerSandboxConstraintsSchema } from "@foundry/sandbox/container/constraints";
import { describe, expect, it } from "vitest";

import {
  isStrictModuleManifest,
  ModuleManifestValidationError,
  PORTABLE_SCHEMA_DIALECT,
  parseModuleManifest,
  parseModuleManifestSourceText,
  parsePortableSchema,
  validateModuleManifestBuild,
} from "../manifest";
import { STRICT_MANIFEST } from "./helpers/module-fixture";

const source = {
  capabilities: [
    {
      alias: "weather",
      capability: "host.network.fetch",
      reason: "Loads forecasts",
      required: false,
      version: 1,
    },
    {
      alias: "account",
      capability: "host.account.read",
      reason: "Reads the profile",
      required: true,
      version: 2,
    },
  ],
  compatibility: { gateway: "1", runtime: "bun@1" },
  data: { protocol: "drizzle-sqlite@1" },
  format: "foundry.module/1",
  program: { entry: "outputs/program/index.js" },
  views: { home: { path: "/" }, settings: { path: "/settings" } },
} as const;

const tree: StorageTree = {
  "outputs/program/index.js": {
    bytes: 10,
    digest: "0".repeat(64),
    mime: "text/javascript",
    type: "file" as const,
  },
};

describe("Module Manifest source and release validation", () => {
  it("normalizes editable source into digest-stable canonical Manifest", async () => {
    const first = parseModuleManifest(source);
    const second = parseModuleManifest({
      ...source,
      capabilities: [...source.capabilities].reverse(),
      views: { home: source.views.home, settings: source.views.settings },
    });

    expect(first.capabilities.map((request) => request.alias)).toEqual([
      "account",
      "weather",
    ]);
    expect(Object.keys(first.views)).toEqual(["home", "settings"]);
    await expect(digestJson(first)).resolves.toBe(await digestJson(second));
    expect(parseModuleManifestSourceText(JSON.stringify(source))).toEqual(
      first
    );
  });

  it("rejects malformed source text and invalid View routes", () => {
    expect(() => parseModuleManifestSourceText("not JSON")).toThrow(
      ModuleManifestValidationError
    );
    expect(() =>
      parseModuleManifest({
        ...source,
        views: { broken: { path: "/settings//account" } },
      })
    ).toThrow("absolute route");
  });

  it.each([
    [
      "unknown dialect",
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
      },
    ],
    ["arbitrary JSON", { $schema: PORTABLE_SCHEMA_DIALECT, oneOf: [] }],
    [
      "properties without object",
      { $schema: PORTABLE_SCHEMA_DIALECT, properties: {} },
    ],
  ])("rejects %s as a portable schema", (_name, schema) => {
    expect(() => parsePortableSchema(schema)).toThrow(
      ModuleManifestValidationError
    );
  });

  it("binds one canonical Manifest to exact Content and a compatible catalog", () => {
    expect(
      validateModuleManifestBuild({
        capabilities: [
          { capability: "host.account.read", version: 2 },
          { capability: "host.network.fetch", version: 1 },
        ],
        manifest: source,
        paths: Object.keys(tree),
      })
    ).toMatchObject({ program: source.program });

    expect(() =>
      validateModuleManifestBuild({
        capabilities: [{ capability: "host.account.read", version: 2 }],
        manifest: source,
        paths: Object.keys(tree),
      })
    ).toThrow("selects unavailable capability");
    expect(() =>
      validateModuleManifestBuild({
        capabilities: [],
        manifest: {
          ...source,
          program: { entry: "outputs/program/missing.js" },
        },
        paths: Object.keys(tree),
      })
    ).toThrow("absent from the Content tree");
  });
});

describe("Strict foundry.module-manifest/1 Manifests", () => {
  it("parses every added declaration into one canonical value", async () => {
    const first = parseModuleManifest(STRICT_MANIFEST);
    const reordered = parseModuleManifest({
      ...STRICT_MANIFEST,
      editors: [
        {
          ...STRICT_MANIFEST.editors[0],
          mimeTypes: ["text/markdown", "text/plain"],
        },
      ],
      network: {
        ...STRICT_MANIFEST.network,
        destinations: [
          { host: "cdn.example.com" },
          { host: "API.example.com", ports: [443] },
        ],
      },
    });

    expect(first).toMatchObject({
      format: "foundry.module-manifest/1",
      persistence: { files: "installation" },
      resources: { cpus: 1, memoryBytes: 268_435_456 },
    });
    expect(isStrictModuleManifest(first)).toBe(true);
    expect(parseModuleManifest(first)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(
      isStrictModuleManifest(reordered) && reordered.network?.destinations
    ).toEqual([
      { host: "api.example.com", ports: [443] },
      { host: "cdn.example.com" },
    ]);
    expect(
      isStrictModuleManifest(reordered) && reordered.editors?.[0]?.mimeTypes
    ).toEqual(["text/markdown", "text/plain"]);
    await expect(
      digestJson(
        parseModuleManifest({
          ...STRICT_MANIFEST,
          editors: [
            {
              ...STRICT_MANIFEST.editors[0],
              mimeTypes: ["text/markdown", "text/plain"],
            },
          ],
        })
      )
    ).resolves.toBe(await digestJson(first));
  });

  it("keeps the legacy format and its semantics alongside the strict one", () => {
    const legacy = parseModuleManifest(source);
    expect(legacy.format).toBe("foundry.module/1");
    expect(isStrictModuleManifest(legacy)).toBe(false);
    expect(() =>
      parseModuleManifest({ ...source, persistence: { files: "none" } })
    ).toThrow("persistence");
  });

  it("names both supported formats when it meets an unknown one", () => {
    expect(() =>
      parseModuleManifest({ ...STRICT_MANIFEST, format: "foundry.module/2" })
    ).toThrow(
      'unsupported format "foundry.module/2"; this reader supports foundry.module/1 and foundry.module-manifest/1'
    );
    expect(() => parseModuleManifest([])).toThrow("unsupported format null");
  });

  it.each([
    [
      "a top-level $schema",
      { $schema: "./foundry.module.schema.json" },
      'Unrecognized key: "$schema"',
    ],
    [
      "data without Installation persistence",
      {
        data: { protocol: "drizzle-sqlite@1" },
        persistence: { files: "none" },
      },
      'data requires persistence.files "installation"',
    ],
    [
      "data with no persistence declaration",
      { data: { protocol: "drizzle-sqlite@1" }, persistence: undefined },
      'data requires persistence.files "installation"',
    ],
    [
      "an editor for an undeclared View",
      { editors: [{ mimeTypes: ["text/plain"], mode: "read", view: "nope" }] },
      'editor View "nope" is not declared in views',
    ],
    [
      "two editors for one View",
      {
        editors: [
          { mimeTypes: ["text/plain"], mode: "read", view: "edit" },
          { mimeTypes: ["text/markdown"], mode: "write", view: "edit" },
        ],
      },
      'editor View "edit" is declared more than once',
    ],
    [
      "a repeated editor MIME type",
      {
        editors: [
          {
            mimeTypes: ["text/plain", "text/plain"],
            mode: "read",
            view: "edit",
          },
        ],
      },
      "editor MIME types must be unique",
    ],
    [
      "an editor mode other than read or write",
      { editors: [{ mimeTypes: ["text/plain"], mode: "admin", view: "edit" }] },
      "editors.0.mode",
    ],
    [
      "one Capability requested under two aliases",
      {
        capabilities: [
          {
            alias: "paris",
            capability: "host.weather.read",
            constraints: { city: "Paris" },
            reason: "Shows the Paris forecast",
            version: 1,
          },
          {
            alias: "rome",
            capability: "host.weather.read",
            constraints: { city: "Rome" },
            reason: "Shows the Rome forecast",
            version: 2,
          },
        ],
      },
      'capability "host.weather.read" is requested more than once',
    ],
    [
      "a repeated network destination",
      {
        network: {
          destinations: [
            { host: "api.example.com" },
            { host: "api.example.com" },
          ],
          reason: "x",
        },
      },
      'network destination "api.example.com" is duplicated',
    ],
    [
      "a network address that is not a host name",
      { network: { destinations: [{ host: "10.0.0.1" }], reason: "x" } },
      "must be a DNS host name",
    ],
    [
      "a non-positive resource",
      { resources: { memoryBytes: 0 } },
      "resources.memoryBytes",
    ],
    [
      "an unknown setting",
      { settings: { "theme.color": { default: 1 } } },
      "theme.color is not a Module setting",
    ],
    [
      "network as a setting",
      { settings: { network: { default: 1 } } },
      "network is authority, not a setting",
    ],
    [
      "Artifact access as a setting",
      { settings: { "artifacts.access": { default: 1 } } },
      "artifacts.access is authority, not a setting",
    ],
    [
      "the idle policy as a setting",
      { settings: { "sandbox.idlePolicy": { default: 1 } } },
      "sandbox.idlePolicy is fixed",
    ],
    [
      "a resource as a setting",
      { settings: { "resources.memoryBytes": { minimum: 1 } } },
      "declare resources.memoryBytes in resources, not settings",
    ],
    [
      "a fractional count",
      { settings: { "authoring.maxSteps": { default: 1.5 } } },
      "authoring.maxSteps must be a positive integer",
    ],
    [
      "a default below its minimum",
      { settings: { "explorer.pageSize": { default: 10, minimum: 20 } } },
      "explorer.pageSize default must not be below its minimum",
    ],
    [
      "an empty setting request",
      { settings: { "explorer.pageSize": {} } },
      "explorer.pageSize must declare a default or a minimum",
    ],
  ])("rejects %s with a clear message", (_name, change, message) => {
    expect(() =>
      parseModuleManifest({ ...STRICT_MANIFEST, ...change })
    ).toThrow(message);
  });

  it("asks for network in the sandbox destination allowlist's own shape", () => {
    const manifest = parseModuleManifest(STRICT_MANIFEST);
    const destinations =
      (isStrictModuleManifest(manifest) && manifest.network?.destinations) ||
      [];
    expect(
      containerSandboxConstraintsSchema.parse({
        format: "foundry.sandbox.container/1",
        network: { destinations, mode: "allowlist" },
      }).network
    ).toEqual({ destinations, mode: "allowlist" });
  });

  it("validates strict release builds against the same catalog", () => {
    expect(
      validateModuleManifestBuild({
        capabilities: [],
        manifest: STRICT_MANIFEST,
        paths: ["outputs/program/server.js"],
      })
    ).toEqual(parseModuleManifest(STRICT_MANIFEST));
  });
});
