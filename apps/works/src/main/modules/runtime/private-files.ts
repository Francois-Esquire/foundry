import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  type InstallationId,
  installationIdSchema,
} from "@foundry/modules/domain";
import {
  isStrictModuleManifest,
  type ModuleManifest,
} from "@foundry/modules/manifest";
import { createModuleInstallationFiles } from "@foundry/modules/node/installation-files";
import type {
  ModuleFilesPersistence,
  ModuleInstallationFiles,
} from "@foundry/modules/platform/files";
import {
  MODULE_FILES_ROOT,
  MODULE_PROGRAM_ROOT,
} from "@foundry/modules/platform/program-runtime";
import { KeyedTurns } from "@foundry/modules/platform/turns";
import type { ContainerSandboxConstraints } from "@foundry/sandbox/container/constraints";
import type { Containers } from "@foundry/sandbox/container/containers";
import { moduleDirectory, moduleFolder } from "../local-library";
import { ModuleRuntimeError } from "./controller";
import { moveLegacyData } from "./data-move";

export function filesPersistence(
  manifest: ModuleManifest
): ModuleFilesPersistence {
  return isStrictModuleManifest(manifest)
    ? (manifest.persistence?.files ?? "none")
    : "installation";
}

export interface ModulePrivateFiles extends ModuleInstallationFiles {
  mounts(installationId: string): {
    readonly files: readonly string[];
    readonly program: string;
  };
  stopped(installationId: InstallationId): Promise<void>;
}

const DATA = installationIdSchema.parse("data");

export function createModulePrivateFiles(options: {
  readonly checkDatabase: (file: string) => Promise<void>;
  readonly installationFiles?: typeof createModuleInstallationFiles;
  readonly root: string;
  readonly snapshotDatabase: (
    source: string,
    destination: string
  ) => Promise<void>;
}): ModulePrivateFiles {
  const { root, snapshotDatabase } = options;
  const filesStore = options.installationFiles ?? createModuleInstallationFiles;
  const disposableRoot = path.resolve(root, ".library", "disposable");
  const disposable = filesStore({
    root: disposableRoot,
    snapshotDatabase,
  });
  const preparedDisposable = new Map<InstallationId, string>();
  const kept = new Map<string, ModuleInstallationFiles>();
  const disposed = new Set<InstallationId>();
  const moved = new Set<InstallationId>();
  const turns = new KeyedTurns<InstallationId>();

  function persistent(id: InstallationId) {
    const folder = moduleFolder(root, id).root;
    let files = kept.get(folder);
    if (!files) {
      files = filesStore({ root: folder, snapshotDatabase });
      kept.set(folder, files);
    }
    return files;
  }
  const disposableId = (id: InstallationId) =>
    installationIdSchema.parse(moduleDirectory(id));
  function migrate(id: InstallationId) {
    return turns.run(id, async () => {
      if (moved.has(id)) {
        return;
      }
      await moveLegacyData({
        checkDatabase: options.checkDatabase,
        from: path.join(root, ".data", moduleDirectory(id)),
        snapshotDatabase,
        state: path.join(
          root,
          ".library",
          "data-moves",
          `${moduleDirectory(id)}.json`
        ),
        to: moduleFolder(root, id).data,
      });
      moved.add(id);
    });
  }

  return {
    async backup(id) {
      await migrate(id);
      await persistent(id).backup(DATA);
    },
    delete: () => Promise.resolve(),
    async discardBackup(id) {
      await migrate(id);
      await persistent(id).discardBackup(DATA);
    },
    mounts(id) {
      const folder = moduleFolder(root, id);
      const prepared = preparedDisposable.get(installationIdSchema.parse(id));
      return {
        files: [prepared ?? folder.data],
        program: folder.artifact,
      };
    },
    async prepare({ installationId, persistence, signal }) {
      await migrate(installationId);
      if (persistence === "none") {
        disposed.add(installationId);
        await disposable.delete(disposableId(installationId));
        const prepared = await disposable.prepare({
          installationId: disposableId(installationId),
          persistence,
          ...(signal === undefined ? {} : { signal }),
        });
        preparedDisposable.set(
          installationId,
          disposablePath(disposableRoot, disposableId(installationId), prepared)
        );
        return { hostPath: prepared.hostPath, installationId };
      }
      disposed.delete(installationId);
      preparedDisposable.delete(installationId);
      const prepared = await persistent(installationId).prepare({
        installationId: DATA,
        persistence,
        ...(signal === undefined ? {} : { signal }),
      });
      return { hostPath: prepared.hostPath, installationId };
    },
    release: (id) =>
      disposed.has(id)
        ? disposable.release(disposableId(id))
        : persistent(id).release(DATA),
    async restoreBackup(id) {
      await migrate(id);
      return await persistent(id).restoreBackup(DATA);
    },
    async stopped(id) {
      if (disposed.delete(id)) {
        preparedDisposable.delete(id);
        await disposable.release(disposableId(id));
      }
    },
  };
}

function disposablePath(
  disposableRoot: string,
  installationId: InstallationId,
  prepared: { readonly hostPath: string }
): string {
  const hostPath = path.resolve(prepared.hostPath);
  const expected = [
    path.join(disposableRoot, installationId),
    path.join(disposableRoot, ".ephemeral", installationId),
  ];
  if (!expected.includes(hostPath)) {
    throw new ModuleRuntimeError(
      "The Module's disposable files were prepared outside their directory"
    );
  }
  return hostPath;
}

export function restrictProgramMounts(
  containers: Containers,
  files: Pick<ModulePrivateFiles, "mounts">
): Containers {
  async function check(spec: ContainerSandboxConstraints) {
    const installationId = spec.labels?.["com.foundry.installation"];
    if (installationId === undefined) {
      throw new ModuleRuntimeError(
        "A Module app container has no Installation"
      );
    }
    const allowed = files.mounts(installationId);
    const program = await realpath(allowed.program).catch(() => null);
    const writable = await Promise.all(
      allowed.files.map((file) => realpath(file).catch(() => null))
    );
    for (const mount of spec.mounts ?? []) {
      const source = await realpath(mount.source).catch(() => null);
      const permitted =
        source !== null &&
        (mount.target === MODULE_PROGRAM_ROOT
          ? mount.access === "read-only" && source === program
          : mount.target === MODULE_FILES_ROOT &&
            mount.access === "read-write" &&
            writable.includes(source));
      if (!permitted) {
        throw new ModuleRuntimeError(
          "A Module app may mount only its artifact folder read-only and its data folder read-write"
        );
      }
    }
  }
  return Object.freeze<Containers>({
    ...containers,
    async restart(id, spec, signal) {
      if (spec) {
        await check(spec);
      }
      await containers.restart(id, spec, signal);
    },
    async start(spec, signal) {
      await check(spec);
      return await containers.start(spec, signal);
    },
  });
}
