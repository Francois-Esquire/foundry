import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CONTAINER_SANDBOX_CONSTRAINTS_FORMAT } from "@foundry/sandbox/container/constants";
import type { ContainerSandboxConstraints } from "@foundry/sandbox/container/constraints";
import type {
  Container,
  Containers,
} from "@foundry/sandbox/container/containers";

import type { ManagerArgs } from "../bindings";
import type { Frame } from "../run-scope";
import { current } from "../run-scope";
import type {
  ImageSandbox,
  Sandbox,
  SandboxDefinition,
  Sandboxes,
  SandboxSpec,
} from "../types";

/** MicroSandbox lifecycle and workspace mounts, scoped to the workflow frame. */

export interface SandboxesDeps {
  /** Lazy: the runtime is optional and may not be installed. */
  readonly containers: () => Promise<Containers>;
  /** The user's home; host configuration folders live under it. */
  readonly home: string;
  /** The config's directory. */
  readonly root: string;
}

const WORKSPACE_TARGET = "/workspace";
const managedSandboxes = new WeakMap<Sandbox, Container>();

export function sandboxContainer(sandbox: Sandbox): Container {
  const container = managedSandboxes.get(sandbox);
  if (!container) {
    throw new Error("The sandbox must be opened by this Quirks runtime.");
  }
  return container;
}
const KIND = "sandboxes.start";

/** Where a sandbox's mounts resolve from. */
export interface MountDirs {
  /** The step's working directory: the config's, or a worktree inside a callback. */
  readonly cwd: string;
  /** The config's directory; declared workspace paths are relative to it. */
  readonly root: string;
}

/** The host directory a spec's `mount` refers to. */
function mountSource(spec: ImageSandbox, dirs: MountDirs): string {
  if (spec.mount === undefined || spec.mount === ".") {
    return dirs.cwd;
  }
  return resolve(dirs.root, spec.mount.path);
}

/** Guest paths for a files sandbox: relative names land under `/workspace`. */
export function guestFiles(
  files: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path.startsWith("/") ? path : `${WORKSPACE_TARGET}/${path}`,
      content,
    ])
  );
}

/** Only explicitly supplied workspace roots are eligible for mounting. */
export function allowedMountRoots(
  roots: readonly string[],
  _home?: string
): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].filter((dir) =>
    existsSync(dir)
  );
}

export function constraintsFor(
  spec: SandboxSpec,
  dirs: MountDirs,
  _home?: string
): ContainerSandboxConstraints {
  const resources = {
    ...(spec.resources?.cpus === undefined
      ? {}
      : { cpus: spec.resources.cpus }),
    ...(spec.resources?.memoryBytes === undefined
      ? {}
      : { memoryBytes: spec.resources.memoryBytes }),
  };
  return {
    format: CONTAINER_SANDBOX_CONSTRAINTS_FORMAT,
    ...(spec.image === undefined ? {} : { image: spec.image }),
    ...(spec.network === undefined ? {} : { network: spec.network }),
    mounts: [
      ...("files" in spec
        ? []
        : [
            {
              access: "read-write" as const,
              executable: spec.executable ?? false,
              id: "workspace",
              source: mountSource(spec, dirs),
              target: WORKSPACE_TARGET,
            },
          ]),
    ],
    ...(Object.keys(resources).length === 0 ? {} : { resources }),
    workdir: WORKSPACE_TARGET,
  };
}

function wrap(container: Container, frame: Frame): Sandbox {
  const handle: Sandbox = {
    close: () => container.close(),
    async exec(argv) {
      const result = await container.commands.exec([...argv], {
        signal: frame.signal,
      });
      return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    },
    id: container.id,
  };
  managedSandboxes.set(handle, container);
  frame.opened.add(handle);
  return handle;
}

export function sandboxesManager(
  deps: SandboxesDeps
): (args: ManagerArgs) => Sandboxes {
  return ({ frame, scope }) => ({
    async open(id) {
      const containers = await deps.containers();
      return wrap(await containers.open(id, frame.signal), frame);
    },
    async start(sandbox: SandboxDefinition | SandboxSpec) {
      const { key } = scope.claim(frame, KIND);
      const containers = await deps.containers();
      const recorded = scope.ledger.get<string>(key);
      if (recorded !== undefined) {
        // A container never outlives the process that started it: a run
        // adopted after a restart starts a fresh one under the same key.
        try {
          return wrap(await containers.open(recorded, frame.signal), frame);
        } catch {
          scope.ledger.set(key, undefined);
        }
      }
      const container = await containers.start(
        constraintsFor(
          sandbox,
          { cwd: current.getStore()?.cwd ?? deps.root, root: deps.root },
          deps.home
        ),
        frame.signal
      );
      try {
        if ("files" in sandbox) {
          await container.files.copyIn(guestFiles(sandbox.files));
        }
      } catch (error) {
        await container.close();
        throw error;
      }
      scope.ledger.set(key, container.id);
      return wrap(container, frame);
    },
  });
}
