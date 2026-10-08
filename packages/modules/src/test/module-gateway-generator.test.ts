import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  generateModuleGatewayClient,
  ModuleGatewayGenerationError,
} from "../gateway/generator";
import type {
  ModuleCapabilityCatalog,
  ModuleCapabilityDescriptor,
} from "../gateway/types";
import { PORTABLE_SCHEMA_DIALECT } from "../manifest";
import { buildModuleSdkPack } from "../sdk";

const UNAVAILABLE_EVENTS_ALIAS =
  /alias "events".*platform.activity@2.*not available/;
const UNAVAILABLE_NOTIFICATIONS_VERSION =
  /platform.notifications@99.*not available/;
const stringSchema = {
  $schema: PORTABLE_SCHEMA_DIALECT,
  type: "string",
} as const;
const notification: ModuleCapabilityDescriptor = {
  capability: "platform.notifications",
  documentation: "Send a notification.",
  input: {
    $schema: PORTABLE_SCHEMA_DIALECT,
    additionalProperties: false,
    properties: { title: stringSchema },
    required: ["title"],
    type: "object",
  },
  mode: "unary",
  output: {
    $schema: PORTABLE_SCHEMA_DIALECT,
    additionalProperties: false,
    properties: {
      delivered: { $schema: PORTABLE_SCHEMA_DIALECT, type: "boolean" },
    },
    required: ["delivered"],
    type: "object",
  },
  version: 1,
};
const activity: ModuleCapabilityDescriptor = {
  capability: "platform.activity",
  documentation: "Observe activity.",
  event: {
    $schema: PORTABLE_SCHEMA_DIALECT,
    additionalProperties: false,
    properties: { message: stringSchema },
    required: ["message"],
    type: "object",
  },
  input: { $schema: PORTABLE_SCHEMA_DIALECT, type: "null" },
  mode: "stream",
  version: 2,
};

const catalog: ModuleCapabilityCatalog = {
  capabilities: [notification, activity],
  generation: 1,
};
const manifest = {
  capabilities: [
    {
      alias: "notify",
      capability: "platform.notifications",
      reason: "Send a user-visible notification.",
      version: 1,
    },
    {
      alias: "events",
      capability: "platform.activity",
      reason: "Show fresh activity.",
      version: 2,
    },
  ],
  compatibility: { gateway: "1", runtime: "bun@1" },
  data: { protocol: "drizzle-sqlite@1" },
  format: "foundry.module/1",
  program: { entry: "outputs/program/index.js" },
  views: {},
} as const;

describe("Module Gateway generated client", () => {
  it("selects namespaced capabilities into typed call and observe aliases", () => {
    const source = generateModuleGatewayClient({ catalog, manifest });

    expect(source).toContain("readonly notify");
    expect(source).toContain(
      'call(input: { readonly "title": string; }, options?'
    );
    expect(source).toContain("readonly events");
    expect(source).toContain(
      'observe(input: null, options?: { signal?: AbortSignal }): AsyncIterable<{ readonly "message": string; }>'
    );
    expect(source).toContain('client.call("notify", input, options)');
    expect(source).toContain('client.observe("events", input, options)');
    expect(source).not.toContain("Send a notification.");
  });

  it("emits deterministically and typechecks from root foundry.module.json", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "module-gateway-"));
    try {
      const first = generateModuleGatewayClient({ catalog, manifest });
      const second = generateModuleGatewayClient({ catalog, manifest });

      expect(second).toBe(first);
      await expectTypecheck(root, first);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("agrees byte for byte with the generator shipped into the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "module-sdk-generate-"));
    try {
      const generateWithSdk = await installSdkGenerator(root);

      await expect(generateWithSdk({ catalog, manifest })).resolves.toBe(
        generateModuleGatewayClient({ catalog, manifest })
      );

      const unsupported = {
        ...catalog,
        capabilities: [
          {
            ...notification,
            input: { ...stringSchema, format: "email" },
          },
          activity,
        ] as ModuleCapabilityDescriptor[],
      };
      expect(() =>
        generateModuleGatewayClient({ catalog: unsupported, manifest })
      ).toThrow(ModuleGatewayGenerationError);
      await expect(
        generateWithSdk({ catalog: unsupported, manifest })
      ).rejects.toThrow('unsupported member "format"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("makes removed, colliding, incompatible, and version-mismatched entries actionable", () => {
    expect(() =>
      generateModuleGatewayClient({
        catalog: { ...catalog, capabilities: [notification] },
        manifest,
      })
    ).toThrow(UNAVAILABLE_EVENTS_ALIAS);

    expect(() =>
      generateModuleGatewayClient({
        catalog: { ...catalog, capabilities: [notification, notification] },
        manifest,
      })
    ).toThrow("duplicate capability platform.notifications@1");

    expect(() =>
      generateModuleGatewayClient({
        catalog: {
          ...catalog,
          capabilities: [
            { ...notification, input: { ...stringSchema, $schema: "wrong" } },
            activity,
          ] as ModuleCapabilityDescriptor[],
        },
        manifest,
      })
    ).toThrow(ModuleGatewayGenerationError);

    expect(() =>
      generateModuleGatewayClient({
        catalog,
        manifest: {
          ...manifest,
          capabilities: [{ ...manifest.capabilities[0], version: 99 }],
        },
      })
    ).toThrow(UNAVAILABLE_NOTIFICATIONS_VERSION);
  });
});

/** Runs the generator exactly as the composed Module workspace consumes it. */
async function installSdkGenerator(
  root: string
): Promise<(input: object) => Promise<string>> {
  const pack = await buildModuleSdkPack();
  await writeFile(
    path.join(root, "generate.js"),
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Record keys may be absent at runtime.
    pack.files["dist/generate.js"] ?? ""
  );
  await writeFile(
    path.join(root, "run.mjs"),
    `import { readFile } from "node:fs/promises";
import { generateModuleGatewayClient } from "./generate.js";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
process.stdout.write(generateModuleGatewayClient(input));
`
  );
  return async (input) => {
    const inputPath = path.join(root, "input.json");
    await writeFile(inputPath, JSON.stringify(input));
    const result = await promisify(execFile)(process.execPath, [
      path.join(root, "run.mjs"),
      inputPath,
    ]);
    return result.stdout;
  };
}

async function expectTypecheck(root: string, generated: string): Promise<void> {
  const sdk = await buildModuleSdkPack();
  const sdkRoot = path.join(root, "node_modules/@foundry/module-sdk");
  await mkdir(sdkRoot, { recursive: true });
  await writeFile(path.join(root, "gateway.ts"), generated);
  await writeFile(
    path.join(root, "usage.ts"),
    `import { bindModuleGateway } from "./gateway";
import type { GatewayClient } from "@foundry/module-sdk";

declare const client: GatewayClient;
const gateway = bindModuleGateway(client);
void gateway.notify.call({ title: "Hello" }).then((result) => result.delivered);
for await (const event of gateway.events.observe(null)) void event.message;
// @ts-expect-error title is required
void gateway.notify.call({});
// @ts-expect-error stream aliases do not expose call
void gateway.events.call(null);
`
  );
  await writeFile(
    path.join(sdkRoot, "index.d.ts"),
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Record keys may be absent at runtime.
    sdk.files["dist/index.d.ts"] ?? ""
  );
  await writeFile(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({ name: "@foundry/module-sdk", types: "index.d.ts" })
  );
  const program = ts.createProgram({
    options: {
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [path.join(root, "usage.ts")],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(
    diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
    )
  ).toEqual([]);
}
