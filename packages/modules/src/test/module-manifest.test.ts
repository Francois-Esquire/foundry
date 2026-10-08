import type { StorageTree } from "@foundry/core/storage";
import { digestJson } from "@foundry/lib/digest";
import { describe, expect, it } from "vitest";

import {
  ModuleManifestValidationError,
  PORTABLE_SCHEMA_DIALECT,
  parseModuleManifest,
  parseModuleManifestSourceText,
  parsePortableSchema,
  validateModuleManifestBuild,
} from "../manifest";

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
