import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ModuleCapabilityProvider,
  ModuleGatewayInvocationRecord,
} from "@foundry/modules/gateway/types";
import { createModuleSystem } from "@foundry/modules/platform/system";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import type { WorksExecution } from "~/main/execution/contract";
import type { ModulePersistence } from "../artifact-store";
import type { SandboxCapacity } from "../sandboxes/capacity";
import type { ModuleSettings } from "../settings";
import { type ModuleRuntime, ModuleRuntimeError } from "./controller";
import { createInstalledPrograms } from "./installed";
import {
  createModulePrivateFiles,
  restrictProgramMounts,
} from "./private-files";
import { createModuleReleaseFiles } from "./release-files";
import { checkSqlite, snapshotSqlite } from "./sqlite";
import { connectModuleSocket } from "./websocket";

export interface ModuleRuntimeOptions {
  readonly capacity: SandboxCapacity;
  /** Version selection runs on the engine's `system` queue. */
  readonly execution: Pick<WorksExecution, "dispatch">;
  /** Told of each Gateway invocation a Program makes (to record it on its run). */
  readonly observeInvocation?: (record: ModuleGatewayInvocationRecord) => void;
  /**
   * The Module records' one shared manager and ModuleStore (spec §2):
   * Installations, Grants and releases are read and written through the
   * same transactions as the library's saves and Access.
   */
  readonly persistence: ModulePersistence;
  /** The Gateway providers released Programs call, bound to Works' services. */
  readonly providers: readonly ModuleCapabilityProvider[];
  /** The Modules root: each Module's folder holds `source/`, `artifact/` and `data/`. */
  readonly root: string;
  /** Each Module's user setting values; none chosen when absent. */
  readonly settings?: Pick<ModuleSettings, "user">;
  /** Told after a Program's confirmed stop: work it started ends with it. */
  readonly stopped?: (installationId: string) => Promise<void>;
}

/**
 * Released Programs on Microsandbox. Each Module's one Installation and its
 * Grants live in the library's Artifact-backed ModuleStore and survive
 * closing the app and restarting Works. A Program runs the selected
 * release's `artifact/` read-only, with its Module's `data/` (or disposable
 * files) as the only writable mount.
 */
export async function createModuleRuntime(
  options: ModuleRuntimeOptions
): Promise<ModuleRuntime> {
  const { createMicrosandboxRuntime } = await import(
    "@foundry/sandbox/container/microsandbox-runtime"
  );
  const { root } = options;
  const { artifacts, modules: store } = options.persistence;
  // Only checkouts of earlier Works versions live here; it is removed at quit.
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
  const releases = createModuleReleaseFiles({ artifacts, root });
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
