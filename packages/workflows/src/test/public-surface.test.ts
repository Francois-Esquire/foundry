import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";
import type { Factory, RunExecutionContext, Runnable } from "../definitions";
import type { JsonValue } from "../index";
import {
  isJsonValue,
  restoreWorkflow,
  Step,
  Workflow,
  WorkflowCheckpointSchema,
  workflowHandler,
} from "../index";
import type {
  WorkflowCheckpoint,
  WorkflowExecution,
  WorkflowHandlerOptions,
  WorkflowRunFactory,
} from "../queue-handler";
import type { SuspensionRequest, SuspensionState } from "../slices/channels";
import type { BaseContext } from "../slices/executable";
import type {
  StepSnapshot,
  StepStatus,
  WorkflowSnapshot,
} from "../slices/snapshot";
import type { StepContext, StepSpec } from "../step";
import type {
  AfterFailureStepHook,
  AfterFailureStepHookInput,
  AfterSuccessStepHook,
  AfterSuccessStepHookInput,
  AfterSuspensionStepHook,
  AfterSuspensionStepHookInput,
  BeforeStepHook,
  StepHooks,
} from "../step-hooks";
import { withStepHooks } from "../step-hooks";
import type { RunStatus } from "../types";
import type { WorkflowResult } from "../workflow";

type PublicTypePins = [
  Factory,
  Runnable,
  RunExecutionContext,
  WorkflowCheckpoint,
  WorkflowExecution,
  WorkflowHandlerOptions,
  WorkflowRunFactory,
  StepSpec,
  StepContext,
  BeforeStepHook,
  AfterSuccessStepHook,
  AfterSuccessStepHookInput,
  AfterFailureStepHook,
  AfterFailureStepHookInput,
  AfterSuspensionStepHook,
  AfterSuspensionStepHookInput,
  StepHooks,
  WorkflowResult,
  WorkflowSnapshot,
  StepSnapshot,
  StepStatus,
  SuspensionState,
  SuspensionRequest,
  BaseContext,
  RunStatus,
  JsonValue,
];

export type PublicSurfacePins = PublicTypePins;

const packageJsonUrl = new URL("../../package.json", import.meta.url);
const expectedExportKeys = [
  ".",
  "./approval",
  "./authored",
  "./channels",
  "./definitions",
  "./executable",
  "./queue-handler",
  "./schema",
  "./snapshot",
  "./step",
  "./step-hooks",
  "./types",
  "./workflow",
];

describe("public surface", () => {
  test("value exports remain defined", async () => {
    const [snapshotPublic, channelsPublic, executablePublic] =
      await Promise.all([
        import("../snapshot"),
        import("../channels"),
        import("../executable"),
      ]);
    expect(Step).toBeDefined();
    expect(Workflow).toBeDefined();
    expect(typeof withStepHooks).toBe("function");
    expect(typeof workflowHandler).toBe("function");
    expect(typeof restoreWorkflow).toBe("function");
    expect(typeof WorkflowCheckpointSchema.safeParse).toBe("function");
    expect(isJsonValue({ ok: true })).toBe(true);
    expect(snapshotPublic).not.toHaveProperty("Snapshot");
    expect(channelsPublic).not.toHaveProperty("Channels");
    expect(executablePublic).not.toHaveProperty("Executable");
    expect(Workflow).not.toHaveProperty("make");
    expect(Workflow).not.toHaveProperty("fromStep");
  });

  test("the schema entry defines the kernel's records and their embedded values", async () => {
    const schemaPublic = await import("../schema");
    const recordSchemas = [
      "ChannelEventSchema",
      "ErrorShapeSchema",
      "JsonValueSchema",
      "SnapshotStateSchema",
      "StepSnapshotSchema",
      "StepStatusSchema",
      "SuspensionStateSchema",
      "WorkflowSnapshotSchema",
      "WorkflowStepNodeSchema",
      "WorkflowTelemetrySchema",
    ] as const;

    for (const name of recordSchemas) {
      expect(typeof schemaPublic[name].safeParse).toBe("function");
    }
  });

  test("exports map remains curated and targets existing files", () => {
    const pkg = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      exports: Record<string, { import: string }>;
    };

    expect(Object.keys(pkg.exports).sort()).toEqual(expectedExportKeys.sort());
    for (const entry of Object.values(pkg.exports)) {
      expect(existsSync(new URL(entry.import, packageJsonUrl))).toBe(true);
    }
  });
});

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(SOURCE, "..");

const SQLITE_STACK = /^(drizzle-orm|@libsql\/)/;

const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

interface Manifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, { readonly import: string }>>;
}

const manifest = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")
) as Manifest;

function importsOf(file: string) {
  const text = readFileSync(file, "utf8");
  return [
    ...[...text.matchAll(STATIC_IMPORT)].map((match) => ({
      specifier: match[2] ?? "",
      typeOnly: match[1] !== undefined,
    })),
    ...[...text.matchAll(DYNAMIC_IMPORT)].map((match) => ({
      specifier: match[1] ?? "",
      typeOnly: false,
    })),
  ];
}

function resolved(file: string, specifier: string): string {
  const base = resolve(dirname(file), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(
    `${relative(SOURCE, file)} imports ${specifier}, which is no file`
  );
}

function runtimeGraph(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const { specifier, typeOnly } of importsOf(file)) {
      if (!typeOnly && specifier.startsWith(".")) {
        pending.push(resolved(file, specifier));
      }
    }
  }
  return [...seen];
}

function sourceFiles(): string[] {
  return readdirSync(SOURCE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(SOURCE, file).startsWith("test/"));
}

describe("@foundry/workflows runtime graph", () => {
  test("depends on @foundry/queue and keeps no store of its own", () => {
    expect(manifest.dependencies["@foundry/queue"]).toBe("workspace:*");
    expect(manifest.dependencies).not.toHaveProperty("drizzle-orm");
    expect(
      sourceFiles().filter((file) =>
        importsOf(file).some(({ specifier }) => SQLITE_STACK.test(specifier))
      )
    ).toEqual([]);
  });

  test("every entry loads through files that exist", () => {
    const entries = Object.values(manifest.exports).map((entry) =>
      join(PACKAGE_ROOT, entry.import)
    );

    expect(runtimeGraph(entries).length).toBeGreaterThan(entries.length);
  });
});
