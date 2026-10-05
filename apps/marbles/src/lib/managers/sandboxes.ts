import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CONTAINER_SANDBOX_CONSTRAINTS_FORMAT } from "@foundry/sandbox/container/constants";
import type { ContainerSandboxConstraints } from "@foundry/sandbox/container/constraints";
import type {
  Container,
  Containers,
} from "@foundry/sandbox/container/containers";

import type { ManagerArgs } from "../bindings";
import { current } from "../run-scope";
import type {
  ImageSandbox,
  Sandbox,
  SandboxDefinition,
  Sandboxes,
  SandboxSpec,
} from "../types";

/**
 * Sandbox lifecycle and workspace mounts. Called on the manager, a sandbox
 * is the caller's to close. Through a step's view it stops with the frame
 * and is found again on replay.
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
const managedSandboxes = new WeakMap<Sandbox, Container>();

export function sandboxContainer(sandbox: Sandbox): Container {
  const container = managedSandboxes.get(sandbox);
  if (!container) {
    throw new Error("The sandbox must be opened by this Marbles runtime.");
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

/** A handle over a container; `signal` is read at each exec, since a frame reissues its own. */
function wrap(
  container: Container,
  signal: () => AbortSignal | undefined
): Sandbox {
  const handle: Sandbox = {
    close: () => container.close(),
    async exec(argv) {
      const result = await container.commands.exec([...argv], {
        signal: signal(),
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
  return handle;
}

export class SandboxesManager implements Sandboxes {
  readonly #deps: SandboxesDeps;
  #opened: Promise<Containers> | undefined;

  constructor(deps: SandboxesDeps) {
    this.#deps = deps;
  }

  /** The containers this manager was built over: resolved at first use and kept, so the runtime is started once. */
  containers(): Promise<Containers> {
    this.#opened ??= this.#deps.containers();
    return this.#opened;
  }

  async #open(id: string, signal?: AbortSignal): Promise<Container> {
    const containers = await this.containers();
    return containers.open(id, signal);
  }

  async #start(
    sandbox: SandboxDefinition | SandboxSpec,
    signal?: AbortSignal
  ): Promise<Container> {
    const { home, root } = this.#deps;
    const containers = await this.containers();
    const container = await containers.start(
      constraintsFor(
        sandbox,
        { cwd: current.getStore()?.cwd ?? root, root },
        home
      ),
      signal
    );
    try {
      if ("files" in sandbox) {
        await container.files.copyIn(guestFiles(sandbox.files));
      }
    } catch (error) {
      await container.close();
      throw error;
    }
    return container;
  }

  /** A sandbox that is already running; the caller closes the handle. */
  async open(id: string): Promise<Sandbox> {
    return wrap(await this.#open(id), () => undefined);
  }

  /** Start a sandbox; it runs until the caller closes it or the engine is disposed. */
  async start(sandbox: SandboxDefinition | SandboxSpec): Promise<Sandbox> {
    return wrap(await this.#start(sandbox), () => undefined);
  }

  /** What a step body sees: sandboxes that stop with its frame, and the same one again on replay. */
  scoped({ frame, scope }: ManagerArgs): Sandboxes {
    const attach = (container: Container): Sandbox => {
      const handle = wrap(container, () => frame.signal);
      frame.opened.add(handle);
      return handle;
    };
    return {
      open: async (id) => attach(await this.#open(id, frame.signal)),
      start: async (sandbox) => {
        const { key } = scope.claim(frame, KIND);
        // A runtime that cannot start is an error, not a missing record.
        await this.containers();
        const recorded = scope.ledger.get<string>(key);
        if (recorded !== undefined) {
          // A container never outlives the process that started it: a run
          // adopted after a restart starts a fresh one under the same key.
          try {
            return attach(await this.#open(recorded, frame.signal));
          } catch {
            scope.ledger.set(key, undefined);
          }
        }
        const container = await this.#start(sandbox, frame.signal);
        scope.ledger.set(key, container.id);
        return attach(container);
      },
    };
  }

  /** Shut down the runtime if a sandbox ever opened it. */
  async close(): Promise<void> {
    await this.#opened?.then((containers) => containers.shutdown());
  }
}
