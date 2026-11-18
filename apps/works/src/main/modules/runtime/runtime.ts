import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ModuleCapabilityProvider,
  ModuleGatewayInvocationRecord,
} from "@foundry/modules/gateway/types";
import { createModuleSelectedCheckouts } from "@foundry/modules/node/selected-checkouts";
import { createModuleSystem } from "@foundry/modules/platform/system";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/store/memory";
import type { WorksExecution } from "~/main/execution/contract";
import type { ModulePersistence } from "../artifact-store";
import { moduleFolder } from "../local-library";
import type { SandboxCapacity } from "../sandboxes/capacity";
import type { ModuleSettings } from "../settings";
import { type ModuleRuntime, ModuleRuntimeError } from "./controller";
import { createInstalledPrograms } from "./installed";
import {
  createModulePrivateFiles,
  restrictProgramMounts,
} from "./private-files";
import { checkSqlite, snapshotSqlite } from "./sqlite";
import { connectModuleSocket } from "./websocket";

export interface ModuleRuntimeOptions {
  readonly capacity: SandboxCapacity;
  readonly execution: Pick<WorksExecution, "dispatch">;
  readonly observeInvocation?: (record: ModuleGatewayInvocationRecord) => void;
  readonly persistence: ModulePersistence;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly root: string;
  readonly settings?: Pick<ModuleSettings, "user">;
  readonly stopped?: (installationId: string) => Promise<void>;
}

export async function createModuleRuntime(
  options: ModuleRuntimeOptions
): Promise<ModuleRuntime> {
  const { createMicrosandboxRuntime } = await import(
    "@foundry/sandbox/container/microsandbox-runtime"
  );
  const { root } = options;
  const { artifacts, modules: store } = options.persistence;
  const legacyRuntime = path.join(root, ".runtime");
  const runtime = createMicrosandboxRuntime();
  const files = createModulePrivateFiles({
    checkDatabase: checkSqlite,
    root,
    snapshotDatabase: snapshotSqlite,
  });
  const containers = restrictProgramMounts(
    createContainers({
      allowedMountRoots: [root],
      instanceLabel: createHash("sha256")
        .update(legacyRuntime)
        .digest("hex")
        .slice(0, 16),
      mountTargetRoot: "/foundry",
      runtime,
      store: createMemoryContainerStore(),
    }),
    files
  );
  const releases = createModuleSelectedCheckouts({
    artifacts,
    checkoutPath: (moduleId) => moduleFolder(root, moduleId).artifact,
  });
  const system = createModuleSystem({
    artifacts,
    checkouts: releases,
    containerRuntime: runtime,
    containers,
    files,
    ...(options.observeInvocation === undefined
      ? {}
      : { observeInvocation: options.observeInvocation }),
    providers: options.providers,
    store,
    transport: { connect: connectModuleSocket },
  });
  return createInstalledPrograms({
    capacity: options.capacity,
    execution: options.execution,
    files,
    async prepare() {
      await mkdir(root, { mode: 0o700, recursive: true });
      if (!(await runtime.isInstalled())) {
        throw new ModuleRuntimeError(
          "Modules require the Microsandbox runtime. Install it before opening an app."
        );
      }
      await containers.sweep();
    },
    providers: options.providers,
    releases,
    settings: options.settings ?? { user: () => Promise.resolve({}) },
    async shutdown() {
      await containers.shutdown();
      await rm(legacyRuntime, { force: true, recursive: true });
    },
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    store,
    system,
  });
}
