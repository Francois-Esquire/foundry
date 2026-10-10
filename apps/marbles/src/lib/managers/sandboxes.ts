import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox/constants";
import { CONTAINER_SANDBOX_CONSTRAINTS_FORMAT } from "@foundry/sandbox/container/constants";
import type { ContainerSandboxConstraints } from "@foundry/sandbox/container/constraints";
import type {
  Container,
  Containers,
} from "@foundry/sandbox/container/containers";

import type { ManagerArgs } from "../bindings";
import { workingDirectory } from "../run-scope";
import type {
  ImageSandbox,
  SandboxDefinition,
  Sandboxes,
  SandboxHandle,
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
  /** The config's directory. */
  readonly root: string;
}

const WORKSPACE_TARGET = DEFAULT_SANDBOX_WORKING_DIRECTORY;
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
export function allowedMountRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].filter((dir) =>
    existsSync(dir)
  );
}

export function constraintsFor(
  spec: SandboxSpec,
  dirs: MountDirs
): ContainerSandboxConstraints {
  const target =
    ("target" in spec ? spec.target : undefined) ?? WORKSPACE_TARGET;
  const passed = Object.fromEntries(
    PASSED_THROUGH.flatMap((key) =>
      spec[key] === undefined ? [] : [[key, spec[key]]]
    )
  );
  return {
    format: CONTAINER_SANDBOX_CONSTRAINTS_FORMAT,
    ...passed,
    mounts: [
      ...("files" in spec
        ? []
        : [
            {
              access: "read-write" as const,
              executable: spec.executable ?? false,
              id: "workspace",
              source: mountSource(spec, dirs),
              target,
            },
          ]),
    ],
    workdir: spec.workdir ?? target,
  };
}

/** Spec fields that are the container's constraints as they are. */
const PASSED_THROUGH = [
  "detached",
  "image",
  "labels",
  "network",
  "ports",
  "publicEnvironment",
  "resources",
] as const satisfies readonly (keyof SandboxSpec)[];

/** Where a handle's calls report: the step's signal and stream, read per call. */
interface HandleSite {
  readonly signal: () => AbortSignal | undefined;
  readonly write?: (value: unknown) => void;
}

/** The step's signal joined with one the caller gave. */
function withSignal<O extends { readonly signal?: AbortSignal }>(
  options: O | undefined,
  site: HandleSite
): O & { signal?: AbortSignal } {
  const owned = site.signal();
  const given = options?.signal;
  const signal =
    owned && given ? AbortSignal.any([owned, given]) : (owned ?? given);
  return { ...(options as O), ...(signal ? { signal } : {}) };
}

/**
 * The container, with Marbles' defaults on the calls that run work: each
 * carries the step's signal, and `exec` writes the command and its output
 * to the step's stream. Everything else is the container's own.
 */
function wrap(container: Container, site: HandleSite): SandboxHandle {
  const exec: SandboxHandle["exec"] = async (command, options) => {
    const result = await container.commands.exec(
      command,
      withSignal(options, site)
    );
    if (site.write) {
      const shown = typeof command === "string" ? command : command.join(" ");
      site.write(`$ ${shown}\n${result.stdout}${result.stderr}`);
    }
    return result;
  };
  const processes: SandboxHandle["processes"] = {
    spawn: (command, options) =>
      container.processes.spawn(command, withSignal(options, site)),
    start: (command, options) =>
      container.processes.start(command, withSignal(options, site)),
  };
  const overrides: Record<PropertyKey, unknown> = {
    commands: { exec },
    exec,
    processes,
  };
  // Over an empty target: the container is frozen, and a proxy may not
  // hand out anything but a frozen property's own value.
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "row") {
          return;
        }
        if (Object.hasOwn(overrides, property)) {
          return overrides[property];
        }
        const value = Reflect.get(container, property, container);
        return typeof value === "function" ? value.bind(container) : value;
      },
      has: (_target, property) =>
        property !== "row" &&
        (Object.hasOwn(overrides, property) || property in container),
    }
  ) as SandboxHandle;
}

export class SandboxesManager implements Sandboxes {
  readonly #deps: SandboxesDeps;
  /** The container behind each handle this manager gave out. */
  readonly #handles = new WeakMap<SandboxHandle, Container>();
  #opened: Promise<Containers> | undefined;

  constructor(deps: SandboxesDeps) {
    this.#deps = deps;
  }

  /**
   * The container behind a handle this manager gave out, for what runs a
   * harness inside it. A handle from anywhere else has no container here.
   */
  containerOf(sandbox: SandboxHandle): Container {
    const container = this.#handles.get(sandbox);
    if (!container) {
      throw new Error("The sandbox must be opened by this engine.");
    }
    return container;
  }

  #handle(container: Container, site: HandleSite) {
    const handle = wrap(container, site);
    this.#handles.set(handle, container);
    return handle;
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
    const { root } = this.#deps;
    const containers = await this.containers();
    const container = await containers.start(
      constraintsFor(sandbox, { cwd: workingDirectory(root), root }),
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
  async open(id: string): Promise<SandboxHandle> {
    return this.#handle(await this.#open(id), { signal: () => undefined });
  }

  /** Start a sandbox; it runs until the caller closes it or the engine is disposed. */
  async start(
    sandbox: SandboxDefinition | SandboxSpec
  ): Promise<SandboxHandle> {
    return this.#handle(await this.#start(sandbox), {
      signal: () => undefined,
    });
  }

  /** What a step body sees: sandboxes that stop with its frame, and the same one again on replay. */
  scoped({ frame, scope, write }: ManagerArgs): Sandboxes {
    const attach = (container: Container): SandboxHandle => {
      const handle = this.#handle(container, {
        signal: () => frame.signal,
        write,
      });
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
