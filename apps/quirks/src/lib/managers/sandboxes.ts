import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTAINER_SANDBOX_CONSTRAINTS_FORMAT } from "@foundry/sandbox/container/constants";
import type { ContainerSandboxConstraints } from "@foundry/sandbox/container/constraints";
import type {
  Container,
  Containers,
} from "@foundry/sandbox/container/containers";

import type { ManagerArgs } from "../bindings";
import type { Frame } from "../run-scope";
import type {
  ImageSandbox,
  Sandbox,
  SandboxDefinition,
  Sandboxes,
  SandboxSpec,
} from "../types";

/**
 * Isolated places to run commands, over the containers registry. The mount
 * policy is fixed: the workspace the sandbox is for mounts read/write at
 * `/workspace`; the host's `~/.foundry`, `~/.claude`, and `~/.codex` mount
 * read-only under `/root`, when they exist; nothing else is mounted. A
 * `files` sandbox mounts no workspace: its files are copied under
 * `/workspace` once it boots. Commands are aborted with the step. Handles
 * close when the run settles.
 */

export interface SandboxesDeps {
  /** Lazy: the runtime is optional and may not be installed. */
  readonly containers: () => Promise<Containers>;
  /** The user's home; host configuration folders live under it. */
  readonly home: string;
  /** The config's directory. */
  readonly root: string;
}

const WORKSPACE_TARGET = "/workspace";
const HOST_CONFIG_DIRS = [".foundry", ".claude", ".codex"] as const;
const KIND = "sandboxes.start";

/** The host directory a spec's `mount` refers to. */
function mountSource(spec: ImageSandbox, root: string): string {
  if (spec.mount === undefined || spec.mount === ".") {
    return root;
  }
  return resolve(root, spec.mount.path);
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

/** Host directories the registry may bind: the workspace and the config folders. */
export function allowedMountRoots(
  roots: readonly string[],
  home: string
): string[] {
  return [
    ...new Set([
      ...roots.map((root) => resolve(root)),
      ...HOST_CONFIG_DIRS.map((dir) => join(home, dir)).filter((dir) =>
        existsSync(dir)
      ),
    ]),
  ];
}

export function constraintsFor(
  spec: SandboxSpec,
  root: string,
  home: string
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
    mounts: [
      ...("files" in spec
        ? []
        : [
            {
              access: "read-write" as const,
              id: "workspace",
              source: mountSource(spec, root),
              target: WORKSPACE_TARGET,
            },
          ]),
      ...HOST_CONFIG_DIRS.flatMap((dir) => {
        const source = join(home, dir);
        return existsSync(source)
          ? [
              {
                access: "read-only" as const,
                id: dir.slice(1),
                source,
                target: `/root/${dir}`,
              },
            ]
          : [];
      }),
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
        constraintsFor(sandbox, deps.root, deps.home),
        frame.signal
      );
      if ("files" in sandbox) {
        await container.files.copyIn(guestFiles(sandbox.files));
      }
      scope.ledger.set(key, container.id);
      return wrap(container, frame);
    },
  });
}
